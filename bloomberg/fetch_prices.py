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


def ref_name(session, security):
    """Return the security's NAME if it resolves, else None."""
    svc = session.getService("//blp/refdata")
    req = svc.createRequest("ReferenceDataRequest")
    req.getElement("securities").appendValue(security)
    req.getElement("fields").appendValue("NAME")
    session.sendRequest(req)
    name = None
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
        if ev.eventType() == blpapi.Event.RESPONSE:
            done = True
    return name


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
    for sec in candidates(raw):
        name = ref_name(session, sec)
        if not name:
            continue
        pts = hist(session, sec, start_date, end_date)
        if pts:
            if verbose:
                dates = sorted(pts)
                print(f"  OK   {raw:<10} -> {sec:<18} [{name[:34]:<34}] {len(pts):>4} pts {dates[0]}..{dates[-1]}")
            return {"security": sec, "name": name, "d": pts}
    if verbose:
        print(f"  MISS {raw:<10} (no resolving Bloomberg security)")
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tickers", nargs="*", help="Explicit tickers (default: all Yahoo-dead tickers in price_cache.json)")
    ap.add_argument("--start", type=int, default=2012)
    ap.add_argument("--test", type=int, default=0, help="Resolve only the first N tickers (dry preview, still writes)")
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
                series[raw] = {
                    "security": got["security"],
                    "name": got["name"],
                    "d": got["d"],
                    "first": dates[0],
                    "last": dates[-1],
                    "latest": got["d"][dates[-1]],
                    "latestDate": dates[-1],
                }
                resolved.append(raw)
            else:
                missed.append(raw)
    finally:
        session.stop()

    out = {
        "meta": {
            "fetchedAt": dt.datetime.now().isoformat(timespec="seconds"),
            "field": FIELD,
            "source": "Bloomberg (BLPAPI)",
            "requested": len(tickers),
            "resolved": len(resolved),
            "missed": missed,
            "test": bool(args.test),
        },
        "series": series,
    }
    # In test mode, write a side file so we don't overwrite a real overlay.
    out_path = OUT_PATH.replace(".json", ".test.json") if args.test else OUT_PATH
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f)

    print(f"\nResolved {len(resolved)}/{len(tickers)} -> {os.path.relpath(out_path, HERE)}")
    if missed:
        print(f"Missed ({len(missed)}): {', '.join(missed[:40])}{' ...' if len(missed) > 40 else ''}")


if __name__ == "__main__":
    main()
