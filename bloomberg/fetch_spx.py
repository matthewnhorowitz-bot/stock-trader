"""
Bloomberg S&P 500 total-return fetcher for the Congress Index benchmark.

Pulls a DAILY total-return series for `SPX Index` (field TOT_RETURN_INDEX_GROSS_DVDS,
so Bloomberg reinvests dividends — apples-to-apples with the members' adjusted-close
position pricing) from the local Bloomberg Terminal (BLPAPI on localhost:8194) and writes:

    data/bloomberg_spx.json

The Node app (src/sources/bloombergSpx.js) reads this as the authoritative S&P benchmark
for the Congress Index. CI has no Terminal, so this file is generated locally on a machine
with Bloomberg and committed to the repo as a static input.

ALL_CALENDAR_DAYS + PREVIOUS_VALUE fill gives a value for EVERY calendar day, so the JS
side can look up any boundary (Jan-1/Jul-1, incl. weekends) or trade entry/exit date exactly.

Run:  <python312> bloomberg/fetch_spx.py [--start 2012] [--ticker "SPX Index"]
      (blpapi is typically not on PATH — call Python by full path.)
"""
import argparse
import datetime as dt
import json
import os
import sys

import blpapi

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(HERE, "..", "data", "bloomberg_spx.json")

TICKER = "SPX Index"
FIELD = "TOT_RETURN_INDEX_GROSS_DVDS"


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


def fetch_one(session, ticker, field, start_date, end_date, periodicity):
    svc = session.getService("//blp/refdata")
    req = svc.createRequest("HistoricalDataRequest")
    req.getElement("securities").appendValue(ticker)
    req.getElement("fields").appendValue(field)
    req.set("periodicitySelection", periodicity)
    req.set("startDate", start_date)
    req.set("endDate", end_date)
    req.set("nonTradingDayFillOption", "ALL_CALENDAR_DAYS")
    req.set("nonTradingDayFillMethod", "PREVIOUS_VALUE")

    session.sendRequest(req)

    points = {}
    error = None
    done = False
    while not done:
        ev = session.nextEvent(15000)
        for msg in ev:
            if msg.hasElement("responseError"):
                error = str(msg.getElement("responseError"))
            if not msg.hasElement("securityData"):
                continue
            sd = msg.getElement("securityData")
            if sd.hasElement("securityError"):
                error = str(sd.getElement("securityError").getElementAsString("message"))
            fd = sd.getElement("fieldData")
            for i in range(fd.numValues()):
                row = fd.getValueAsElement(i)
                if not row.hasElement(field):
                    continue
                date = row.getElementAsDatetime("date")
                val = row.getElementAsFloat(field)
                points[date.strftime("%Y-%m-%d")] = val
        if ev.eventType() == blpapi.Event.RESPONSE:
            done = True
    return points, error


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=2012, help="Start year (default 2012, matches priceCache.FROM)")
    ap.add_argument("--ticker", default=TICKER, help="Bloomberg index ticker")
    ap.add_argument("--field", default=FIELD, help="Bloomberg field")
    ap.add_argument("--periodicity", default="DAILY", choices=["DAILY", "WEEKLY", "MONTHLY"])
    args = ap.parse_args()

    start_date = f"{args.start}0101"
    end_date = dt.date.today().strftime("%Y%m%d")
    print(f"Fetching {args.ticker} / {args.field}, {args.periodicity}, {start_date}..{end_date}")

    session = start_session()
    try:
        points, error = fetch_one(session, args.ticker, args.field, start_date, end_date, args.periodicity)
    finally:
        session.stop()

    if error or not points:
        raise SystemExit(f"FAIL {args.ticker}: {error or 'no data returned'}")

    dates = sorted(points.keys())
    series = {d: points[d] for d in dates}
    out = {
        "meta": {
            "fetchedAt": dt.datetime.now().isoformat(timespec="seconds"),
            "ticker": args.ticker,
            "field": args.field,
            "periodicity": args.periodicity,
            "source": "Bloomberg (BLPAPI HistoricalDataRequest)",
            "points": len(series),
            "first": dates[0],
            "last": dates[-1],
        },
        "series": series,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f)

    print(f"OK   {len(series)} pts  {dates[0]} .. {dates[-1]}  -> {os.path.relpath(OUT_PATH, HERE)}")
    sys.exit(0)


if __name__ == "__main__":
    main()
