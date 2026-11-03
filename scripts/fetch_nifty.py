#!/usr/bin/env python3
"""Daily candles for Nifty 50, Bank Nifty and the Nifty 500 stocks -> JSON files in OUT_DIR

Source of candles : Yahoo Finance chart API (free, unofficial)
Source of truth   : NSE official end-of-day files (index close + equity bhavcopy)
A symbol's file is only overwritten when its latest close agrees with NSE's official
close (tolerance TOL). If NSE can't be reached, files are still written but marked
unverified in data/meta.json. Standard library only.
"""
import csv, io, json, os, sys, time, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone

OUT = os.environ.get("OUT_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
TOL = 0.003            # 0.3 % allowed difference vs NSE official close
MIN_CANDLES = 60          # recent IPOs in the Nifty 500 have short histories
SCAN_BARS = 500           # the scanner file keeps the latest 500 candles (small + fast); the 5-year file has everything
IST = timezone(timedelta(hours=5, minutes=30))

# Used only if NSE's Nifty 500 list can't be downloaded AND there is no previous nifty500.json (first run).
FALLBACK = ("ADANIENT ADANIPORTS APOLLOHOSP ASIANPAINT AXISBANK BAJAJ-AUTO BAJFINANCE BAJAJFINSV BEL BHARTIARTL "
            "CIPLA COALINDIA DRREDDY EICHERMOT ETERNAL GRASIM HCLTECH HDFCBANK HDFCLIFE HINDALCO HINDUNILVR "
            "ICICIBANK INDIGO INFY ITC JIOFIN JSWSTEEL KOTAKBANK LT M&M MARUTI NESTLEIND NTPC ONGC POWERGRID "
            "RELIANCE SBILIFE SBIN SHRIRAMFIN SUNPHARMA TATACONSUM TATASTEEL TCS TECHM TITAN TRENT ULTRACEMCO WIPRO").split()

INDICES = {  # app symbol -> (yahoo symbol, NSE official index name)
    "NIFTY": ("^NSEI", "Nifty 50"),
    "BANKNIFTY": ("^NSEBANK", "Nifty Bank"),
}

def get(url, tries=3, headers=None):
    last = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*", **(headers or {})})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception as e:           # noqa: BLE001
            last = e
            time.sleep(1.5 * (k + 1))
    raise RuntimeError(f"{url}: {last}")

def file_key(sym):                      # must match the app: replace(/[^A-Z0-9]/g,'_')
    return "".join(ch if ch.isalnum() and ch.isascii() else "_" for ch in sym.upper())

def parse_yahoo(raw):
    j = json.loads(raw)
    res = (j.get("chart") or {}).get("result")
    if not res:
        raise ValueError("no result: " + str((j.get("chart") or {}).get("error")))
    r = res[0]
    q = r["indicators"]["quote"][0]
    out = []
    for i, ts in enumerate(r.get("timestamp") or []):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c) or min(o, h, l, c) <= 0:
            continue
        v = q["volume"][i] or 0
        day = datetime.fromtimestamp(ts, IST).strftime("%Y-%m-%d")
        out.append({"t": day, "o": round(o, 2), "h": round(max(h, o, c), 2), "l": round(min(l, o, c), 2), "c": round(c, 2), "v": int(v)})
    out.sort(key=lambda x: x["t"])
    return [c for i, c in enumerate(out) if i == 0 or c["t"] != out[i - 1]["t"]]

def yahoo_candles(ysym):
    url = "https://query1.finance.yahoo.com/v8/finance/chart/%s?range=5y&interval=1d&includeAdjustedClose=false" % urllib.parse.quote(ysym)
    return parse_yahoo(get(url))

def nse_stock_list():
    try:
        raw = get("https://archives.nseindia.com/content/indices/ind_nifty500list.csv").decode("utf-8-sig")
        syms = [row["Symbol"].strip() for row in csv.DictReader(io.StringIO(raw)) if row.get("Symbol")]
        if len(syms) >= 400:
            return syms, "nse"
    except Exception as e:               # noqa: BLE001
        print("WARN constituent list:", e)
    try:                                 # reuse yesterday's list
        prev = json.load(open(os.path.join(OUT, "nifty500.json")))
        if len(prev) >= 400:
            return prev, "previous"
    except Exception:                    # noqa: BLE001
        pass
    return FALLBACK, "fallback"

def official_closes(day):
    """-> (index_closes {nse index name: close}, stock_closes {symbol: close}) for date `day`, or ({},{})"""
    d = day.strftime("%d%m%Y")
    idx, stk = {}, {}
    try:
        raw = get("https://archives.nseindia.com/content/indices/ind_close_all_%s.csv" % d, tries=2).decode("utf-8-sig")
        for row in csv.DictReader(io.StringIO(raw)):
            row = {k.strip(): (v or "").strip() for k, v in row.items() if k}
            try:
                idx[row["Index Name"]] = float(row["Closing Index Value"])
            except (KeyError, ValueError):
                pass
    except Exception as e:               # noqa: BLE001
        print("WARN official index file %s: %s" % (d, e))
    try:
        raw = get("https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_%s.csv" % d, tries=2).decode("utf-8-sig")
        for row in csv.DictReader(io.StringIO(raw)):
            row = {k.strip(): (v or "").strip() for k, v in row.items() if k}
            if row.get("SERIES") == "EQ":
                try:
                    stk[row["SYMBOL"]] = float(row["CLOSE_PRICE"])
                except (KeyError, ValueError):
                    pass
    except Exception as e:               # noqa: BLE001
        print("WARN official equity file %s: %s" % (d, e))
    return idx, stk

def latest_official(last_day):
    """Official files for the candle date we just got."""
    d = datetime.strptime(last_day, "%Y-%m-%d")
    idx, stk = official_closes(d)
    return d.strftime("%Y-%m-%d"), idx, stk

def agree(our, official):
    return official > 0 and abs(our - official) / official <= TOL

def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)

def main():
    os.makedirs(OUT, exist_ok=True)
    stocks, list_src = nse_stock_list()
    jobs = [(k, v[0], "index", v[1]) for k, v in INDICES.items()] + [(s, s + ".NS", "stock", s) for s in stocks]

    data, fails = {}, []
    for app_sym, ysym, kind, key in jobs:
        try:
            c = yahoo_candles(ysym)
            if len(c) < MIN_CANDLES:
                raise ValueError("only %d candles" % len(c))
            data[app_sym] = (kind, key, c)
        except Exception as e:           # noqa: BLE001
            fails.append((app_sym, str(e)))
            print("FAIL", app_sym, e)
        time.sleep(0.25)

    ref_day = max((v[2][-1]["t"] for v in data.values()), default=None)
    off_idx, off_stk = ({}, {})
    if ref_day:
        _, off_idx, off_stk = latest_official(ref_day)
    verified_any = bool(off_idx or off_stk)

    meta = {"updated": datetime.now(IST).strftime("%Y-%m-%d %H:%M IST"), "last_candle": ref_day,
            "constituents": list_src, "official_check": verified_any, "symbols": {}}
    written = []
    for app_sym, (kind, key, c) in data.items():
        last = c[-1]
        official = (off_idx if kind == "index" else off_stk).get(key)
        status = "unverified"
        if official is not None:
            if last["t"] == ref_day and not agree(last["c"], official):
                status = "mismatch"
                print("SKIP %s: yahoo %.2f vs NSE %.2f" % (app_sym, last["c"], official))
                fails.append((app_sym, "mismatch vs NSE"))
                meta["symbols"][app_sym] = {"status": status, "yahoo": last["c"], "nse": official}
                continue
            status = "verified" if last["t"] == ref_day else "stale"
        write_json(os.path.join(OUT, file_key(app_sym) + "_1d.json"), c[-SCAN_BARS:])
        write_json(os.path.join(OUT, file_key(app_sym) + "_5y.json"), c)
        written.append(app_sym)
        meta["symbols"][app_sym] = {"status": status, "last": last["t"], "close": last["c"]}

    write_json(os.path.join(OUT, "nifty500.json"), sorted(s for s in stocks if s in written))
    write_json(os.path.join(OUT, "meta.json"), meta)
    print("written %d, failed %d, official check: %s, last candle %s" % (len(written), len(fails), verified_any, ref_day))
    bad_index = any(s in dict(fails) for s in INDICES)
    if bad_index or len(fails) > max(10, len(jobs) // 10):
        sys.exit("too many failures: " + ", ".join(f[0] for f in fails))

if __name__ == "__main__":
    main()
