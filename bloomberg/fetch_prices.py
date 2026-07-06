"""
Bloomberg fallback pricer for the Congress Index survivorship gap.

Yahoo (and Tiingo/Stooq) return nothing for a chunk of tickers — delisted/acquired
names (ATVI, SIVB, PXD, SGEN, RTN...) and live-but-Yahoo-404 names (WBA, MMC, K...).
Bloomberg retains full history for both. This script bulk-pulls daily total-return
history for those tickers from the local Terminal and writes an overlay the Node app
reads BEFORE tombstoning a ticker as unpriceable:

    data/bloomberg_prices.json

Ticker set: by default every `miss` (Yahoo-dead) ticker in data/price_cache.json.
Pass tickers positionally to override, or --test N to resolve only the first N.

For each raw ticker we try a few Bloomberg security spellings (US Equity, share-class
'/', preferred), confirm resolution with a ReferenceDataRequest (NAME) so recycled
tickers can be eyeballed, then pull TOT_RETURN_INDEX_GROSS_DVDS (matches the members'
adjusted-close / total-return basis) with ALL_CALENDAR_DAYS fill so any date resolves.

Run (Terminal must be logged in; blpapi usually not on PATH):
    <python312> bloomberg/fetch_prices.py --test 10
    <python312> bloomberg/fetch_prices.py            # full run over all dead tickers
"""
import argparse
import datetime as dt
import json
import os
import re
import sys

import blpapi

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_PATH = os.path.join(HERE, "..", "data", "price_cache.json")
OUT_PATH = os.path.join(HERE, "..", "data", "bloomberg_prices.json")

FIELD = "TOT_RETURN_INDEX_GROSS_DVDS"

# Curated old->successor map for confirmed 1:1 same-security US renames where Bloomberg's
# automatic path fails: either the old symbol is fully retired (IIVI/VIAC/GPS resolve to a
# securityError) or its EQY_FUND_TICKER is a garbage internal id (CREE->'9966620DUS',
# JEC->'9990213DUS') instead of a usable ticker. The successor line carries the continuous
# total-return history spanning the rename, so pricing the old ticker off it is correct.
# ONLY same-company ticker changes belong here — NOT cash buyouts or foreign successors
# (those would invent a return or price in the wrong currency, so they stay unpriced).
RENAME_MAP = {
    # CREE->WOLF intentionally omitted: Wolfspeed's 2025 Chapter 11 fresh-start reset the
    # security, so WOLF's TR line only starts 2025-09-29 and can't span the old Cree history
    # (2012-2021). No continuous successor exists, so CREE stays unpriced rather than mispriced.
    "IIVI": "COHR US Equity",   # II-VI -> Coherent (2022)
    "VIAC": "PARA US Equity",   # ViacomCBS -> Paramount Global (2022)
    "GPS":  "GAP US Equity",    # Gap Inc ticker change GPS -> GAP (2024)
    "JEC":  "J US Equity",      # Jacobs Engineering -> Jacobs Solutions (2019)
    "ABC":  "COR US Equity",    # AmerisourceBergen -> Cencora (2023)
}


def compress(pts):
    """Drop carried-forward days, keeping only value-change points plus the first and last
    dates. bbClose reconstructs any date as the last kept value on/before it (Bloomberg's
    PREVIOUS_VALUE fill), so this is lossless. Matches the format of the committed overlay."""
    dates = sorted(pts)
    if not dates:
        return pts
    kept, prev = {}, None
    for d in dates:
        if pts[d] != prev:
            kept[d] = pts[d]
            prev = pts[d]
    kept[dates[-1]] = pts[dates[-1]]  # always keep the latest point for latest/latestDate
    return kept


def dead_tickers():
    with open(CACHE_PATH, "r", encoding="utf-8") as f:
        cache = json.load(f)
    return [t for t, e in cache.items() if isinstance(e, dict) and e.get("miss")]


def candidates(raw):
    """Bloomberg security spellings to try, in order. Returns [] for non-equity junk."""
    t = raw.strip().upper()
    if re.search(r"\d{6,}", t):
        return []  # option contract (e.g. SPY160219P00180000)
    if "-USD" in t or t.endswith("USD") or "-EUR" in t:
        return []  # crypto / FX pair
    forms = []
    forms.append(t)  # plain (ATVI, WBA)
    forms.append(t.replace(".", "/").replace("-", "/"))  # share class BRK-B -> BRK/B
    if "$" in t:
        forms.append(t.replace("$", "/"))  # preferred DUK$A -> DUK/A
    if t.isalpha():
        forms.append(t + "Q")  # bankruptcy/delist Q-suffix (SIVB -> SIVBQ, FRC -> FRCQ)
    seen, uniq = [], []
    for f in forms:
        f = f.strip()
        if f and f not in seen:
            seen.append(f)
            uniq.append(f)
    # Try the composite (US) first, then primary exchanges (NYSE, Nasdaq) — some
    # delisted names only resolve on a specific exchange composite, not "US".
    secs = []
    for f in uniq:
        for ex in ("US", "UN", "UW"):
            secs.append(f"{f} {ex} Equity")
    return secs


def start_session():
    opts = blpapi.SessionOptions()
    opts.setServerHost("localhost")
    opts.setServerPort(8194)
    session = blpapi.Session(opts)
    if not session.start():
        raise SystemExit("Could not start BLPAPI session — is the Bloomberg Terminal running and logged in?")
    if not session.openService("//blp/refdata"):
        raise SystemExit("Could not open //blp/refdata service.")
    return session


def resolve_ref(session, security):
    """Return (NAME, MARKET_STATUS, FUND_TICKER) if the security resolves, else (None,)*3.
    MARKET_STATUS ('TKCH'/'ACQU'/... vs 'ACTV') flags renamed/acquired names; EQY_FUND_TICKER
    is the security's CURRENT (successor) ticker after a rename — e.g. CBS->'PARA US',
    FEYE->'MNDT US' — whose line carries the continuous history the old symbol lost."""
    svc = session.getService("//blp/refdata")
    req = svc.createRequest("ReferenceDataRequest")
    req.getElement("securities").appendValue(security)
    for fld in ("NAME", "MARKET_STATUS", "EQY_FUND_TICKER"):
        req.getElement("fields").appendValue(fld)
    session.sendRequest(req)
    name, status, fund = None, None, None
    done = False
    while not done:
        ev = session.nextEvent(15000)
        for msg in ev:
            if not msg.hasElement("securityData"):
                continue
            arr = msg.getElement("securityData")
            for i in range(arr.numValues()):
                sd = arr.getValueAsElement(i)
                if sd.hasElement("securityError"):
                    continue
                fd = sd.getElement("fieldData")
                if fd.hasElement("NAME"):
                    name = fd.getElementAsString("NAME")
                if fd.hasElement("MARKET_STATUS"):
                    status = fd.getElementAsString("MARKET_STATUS")
                if fd.hasElement("EQY_FUND_TICKER"):
                    fund = fd.getElementAsString("EQY_FUND_TICKER")
        if ev.eventType() == blpapi.Event.RESPONSE:
            done = True
    return name, status, fund


def last_change_date(pts):
    """Last date the value actually changed. After a security is acquired/delisted its
    TOT_RETURN value is carried forward flat (ALL_CALENDAR_DAYS/PREVIOUS_VALUE), so the
    last real change is the delisting date. Also skips weekend/holiday fill naturally."""
    dates = sorted(pts)
    last, prev = dates[0], None
    for d in dates:
        if pts[d] != prev:
            last = d
            prev = pts[d]
    return last


def hist(session, security, start_date, end_date):
    svc = session.getService("//blp/refdata")
    req = svc.createRequest("HistoricalDataRequest")
    req.getElement("securities").appendValue(security)
    req.getElement("fields").appendValue(FIELD)
    req.set("periodicitySelection", "DAILY")
    req.set("startDate", start_date)
    req.set("endDate", end_date)
    req.set("nonTradingDayFillOption", "ALL_CALENDAR_DAYS")
    req.set("nonTradingDayFillMethod", "PREVIOUS_VALUE")
    session.sendRequest(req)
    points = {}
    done = False
    while not done:
        ev = session.nextEvent(15000)
        for msg in ev:
            if not msg.hasElement("securityData"):
                continue
            sd = msg.getElement("securityData")
            if sd.hasElement("securityError"):
                done = done
                continue
            fd = sd.getElement("fieldData")
            for i in range(fd.numValues()):
                row = fd.getValueAsElement(i)
                if row.hasElement(FIELD):
                    d = row.getElementAsDatetime("date").strftime("%Y-%m-%d")
                    points[d] = round(row.getElementAsFloat(FIELD), 4)
        if ev.eventType() == blpapi.Event.RESPONSE:
            done = True
    return points


def resolve_one(session, raw, start_date, end_date, verbose):
    end_iso = f"{end_date[0:4]}-{end_date[4:6]}-{end_date[6:8]}"
    # Curated same-company rename: pull the successor line directly (Bloomberg's automatic
    # successor path can't reach it — see RENAME_MAP). Its continuous history spans the rename.
    override = RENAME_MAP.get(raw.strip().upper())
    sec_list = ([override] + candidates(raw)) if override else candidates(raw)
    for sec in sec_list:
        name, status, fund = resolve_ref(session, sec)
        if not name:
            continue
        pts = hist(session, sec, start_date, end_date)
        via = sec
        if not pts and fund and is_us_listing(fund):
            # Ticker resolves by name but carries no history (MARKET_STATUS=TKCH, a ticker
            # change): pull the successor line's continuous history, which spans the rename
            # (CBS->'PARA US', FEYE->'MNDT US', HRS->'LHX US', ...). US listings only — a
            # foreign successor (SNE->'6758 JP', ABB->'ABBN SW') would price the return in
            # the wrong currency, so skip it and leave the position unpriced.
            succ = fund if fund.upper().endswith(" EQUITY") else f"{fund} Equity"
            if succ != sec:
                pts = hist(session, succ, start_date, end_date)
                if pts:
                    via = succ
        if pts:
            lc = last_change_date(pts)
            delisted = lc < prior_days(end_iso, 21)
            last_trade = lc if delisted else None
            if verbose:
                dates = sorted(pts)
                tag = f"  DELIST {lc} [{status}]" if delisted else ""
                succ_tag = "  via successor" if via != sec else ""
                print(f"  OK   {raw:<10} -> {via:<22} [{name[:26]:<26}] {len(pts):>4}pts {dates[0]}..{dates[-1]}{succ_tag}{tag}")
            return {"security": via, "name": name, "d": pts, "lastTrade": last_trade}
    if verbose:
        print(f"  MISS {raw:<10} (no resolving Bloomberg security)")
    return None


def prior_days(iso_date, n):
    return (dt.date.fromisoformat(iso_date) - dt.timedelta(days=n)).isoformat()


def is_us_listing(fund_ticker):
    """True if the fund/successor ticker is a US listing (all US Bloomberg exchange codes
    start with 'U': US/UN/UW/UQ/UR/UA/UP/...). Foreign codes (JP, SW, LN, GR) don't."""
    parts = fund_ticker.strip().split()
    return len(parts) >= 2 and parts[-1].upper().startswith("U")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tickers", nargs="*", help="Explicit tickers (default: all Yahoo-dead tickers in price_cache.json)")
    ap.add_argument("--start", type=int, default=2012)
    ap.add_argument("--test", type=int, default=0, help="Resolve only the first N tickers (dry preview, still writes)")
    ap.add_argument("--merge", action="store_true", help="Merge into the existing overlay instead of overwriting it (for incremental top-up runs on a subset of tickers)")
    args = ap.parse_args()

    tickers = args.tickers or dead_tickers()
    if args.test:
        tickers = tickers[: args.test]
    start_date = f"{args.start}0101"
    end_date = dt.date.today().strftime("%Y%m%d")
    print(f"Resolving {len(tickers)} ticker(s) via Bloomberg, DAILY {FIELD}, {start_date}..{end_date}\n")

    session = start_session()
    series = {}
    resolved, missed = [], []
    try:
        for raw in tickers:
            try:
                got = resolve_one(session, raw, start_date, end_date, verbose=True)
            except Exception as e:  # noqa: BLE001
                print(f"  ERR  {raw:<10} {e}")
                got = None
            if got:
                dates = sorted(got["d"])
                d_compressed = compress(got["d"])  # lastTrade already derived from full series
                series[raw] = {
                    "security": got["security"],
                    "name": got["name"],
                    "d": d_compressed,
                    "first": dates[0],
                    "last": dates[-1],
                    "latest": got["d"][dates[-1]],
                    "latestDate": dates[-1],
                    # delisting date (Bloomberg LAST_TRADEABLE_DT) when in the past — the Node
                    # side force-closes open positions here instead of marking them forward.
                    "lastTrade": got.get("lastTrade"),
                }
                resolved.append(raw)
            else:
                missed.append(raw)
    finally:
        session.stop()

    # In test mode, write a side file so we don't overwrite a real overlay.
    out_path = OUT_PATH.replace(".json", ".test.json") if args.test else OUT_PATH

    # Merge mode: fold newly-resolved tickers into the existing committed overlay so a
    # top-up run over a subset doesn't drop the tickers a prior full run already collected.
    merged = series
    prior = 0
    if args.merge and not args.test and os.path.exists(out_path):
        with open(out_path, "r", encoding="utf-8") as f:
            existing = json.load(f)
        merged = dict(existing.get("series", {}))
        prior = len(merged)
        merged.update(series)  # new resolutions win

    out = {
        "meta": {
            "fetchedAt": dt.datetime.now().isoformat(timespec="seconds"),
            "field": FIELD,
            "source": "Bloomberg (BLPAPI)",
            "requested": len(tickers),
            "resolved": len(resolved),
            "missed": missed,
            "test": bool(args.test),
            "merged": bool(args.merge),
        },
        "series": merged,
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f)

    if args.merge and not args.test:
        print(f"\nMerged: {prior} prior + {len(resolved)} new = {len(merged)} tickers in overlay")
    print(f"\nResolved {len(resolved)}/{len(tickers)} -> {os.path.relpath(out_path, HERE)}")
    if missed:
        print(f"Missed ({len(missed)}): {', '.join(missed[:40])}{' ...' if len(missed) > 40 else ''}")


if __name__ == "__main__":
    main()
