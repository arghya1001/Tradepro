#!/usr/bin/env python3
"""Daily candles for Nifty 50, Bank Nifty and the Nifty 500 stocks, built from NSE's OFFICIAL daily files.

  stocks : sec_bhavdata_full_DDMMYYYY.csv   (open/high/low/close/volume + previous close)
  indices: ind_close_all_DDMMYYYY.csv       (open/high/low/close)

First run builds about 5 years of history; every later run only adds the new trading days.
Stock splits / bonus issues are detected from NSE's own "previous close" and old prices are
adjusted so charts stay continuous. Standard library only.
Output (in OUT_DIR): <SYMBOL>_1d.json (latest 500 candles), <SYMBOL>_5y.json (everything),
nifty500.json (symbol list), meta.json.
"""
import csv, io, json, os, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

OUT = os.environ.get("OUT_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
IST = timezone(timedelta(hours=5, minutes=30))
HISTORY_DAYS = 1830       # about 5 years
SCAN_BARS = 500           # the scanner file keeps the latest 500 candles (small + fast)
SPLIT_TOL = 0.005         # previous-close differing from our last close by more than 0.5 % = corporate action
WORKERS = 10
INDICES = {"nifty 50": "NIFTY", "nifty bank": "BANKNIFTY"}   # NSE index name (lower case) -> app symbol

EQ_URLS = ["https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_%s.csv",
           "https://archives.nseindia.com/products/content/sec_bhavdata_full_%s.csv"]
IDX_URLS = ["https://archives.nseindia.com/content/indices/ind_close_all_%s.csv",
            "https://nsearchives.nseindia.com/content/indices/ind_close_all_%s.csv"]
LIST_URL = "https://archives.nseindia.com/content/indices/ind_nifty500list.csv"

def fetch(url, tries=4):
    """bytes, or None if the file doesn't exist (HTTP 404 = holiday / not published yet). Other errors raise."""
    last = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last = e
        except Exception as e:           # noqa: BLE001
            last = e
        time.sleep(2 * (k + 1))
    raise RuntimeError("%s: %s" % (url, last))

def fetch_any(urls, d):
    """Try each mirror; None only if every mirror says 404."""
    err = None
    for u in urls:
        try:
            b = fetch(u % d)
            if b is not None:
                return b
        except Exception as e:           # noqa: BLE001
            err = e
    if err:
        raise err
    return None

def num(x):
    try:
        return float(str(x).replace(",", "").strip())
    except ValueError:
        return None

def dec(b):
    """NSE's older files are not always UTF-8; never let one odd character stop the run."""
    try:
        t = b.decode("utf-8-sig")
    except UnicodeDecodeError:
        t = b.decode("latin-1")
    return "\n".join(t.splitlines())        # unify \r, \r\n and \n line endings

def file_key(sym):                      # must match the app: replace(/[^A-Z0-9]/g,'_')
    return "".join(ch if ch.isalnum() and ch.isascii() else "_" for ch in sym.upper())

def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)

def stock_list():
    raw = fetch(LIST_URL)
    if raw:
        syms = [r["Symbol"].strip() for r in csv.DictReader(io.StringIO(dec(raw))) if r.get("Symbol")]
        if len(syms) >= 400:
            return syms, "nse"
    try:
        prev = json.load(open(os.path.join(OUT, "nifty500.json")))
        if len(prev) >= 400:
            return prev, "previous"
    except Exception:                    # noqa: BLE001
        pass
    sys.exit("Could not get the Nifty 500 list from NSE")

def parse_day(day, want):
    """-> None (market closed) or ({app_sym: (o,h,l,c,v,prev_close)})"""
    d = day.strftime("%d%m%Y")
    eq = fetch_any(EQ_URLS, d)
    if eq is None:
        return None
    rows = {}
    for r in csv.DictReader(io.StringIO(dec(eq))):
        r = {(k or "").strip(): (v or "").strip() for k, v in r.items()}
        s = r.get("SYMBOL")
        if s not in want or r.get("SERIES") not in ("EQ", "BE", "BZ", "SM", "ST"):
            continue
        o, h, l, c = num(r.get("OPEN_PRICE")), num(r.get("HIGH_PRICE")), num(r.get("LOW_PRICE")), num(r.get("CLOSE_PRICE"))
        if None in (o, h, l, c) or min(o, h, l, c) <= 0:
            continue
        if s in rows and r.get("SERIES") != "EQ":
            continue
        rows[s] = (o, h, l, c, num(r.get("TTL_TRD_QNTY")) or 0, num(r.get("PREV_CLOSE")))
    ix = fetch_any(IDX_URLS, d)
    if ix:
        for r in csv.DictReader(io.StringIO(dec(ix))):
            r = {(k or "").strip(): (v or "").strip() for k, v in r.items()}
            app = INDICES.get(r.get("Index Name", "").lower())
            if not app:
                continue
            o, h, l, c = num(r.get("Open Index Value")), num(r.get("High Index Value")), num(r.get("Low Index Value")), num(r.get("Closing Index Value"))
            if None not in (o, h, l, c) and min(o, h, l, c) > 0:
                rows[app] = (o, h, l, c, num(r.get("Volume")) or 0, None)
    return rows

def load_existing():
    hist = {}
    for fn in os.listdir(OUT) if os.path.isdir(OUT) else []:
        if fn.endswith("_5y.json"):
            try:
                hist[fn[:-8]] = json.load(open(os.path.join(OUT, fn)))
            except Exception:            # noqa: BLE001
                pass
    return hist

def main():
    os.makedirs(OUT, exist_ok=True)
    stocks, list_src = stock_list()
    print("stock list:", len(stocks), "from", list_src, flush=True)
    want = set(stocks) | set(INDICES.values())

    old = load_existing()                                    # keyed by file key
    key_of = {s: file_key(s) for s in want}
    hist = {s: old[key_of[s]] for s in want if key_of[s] in old}
    today = datetime.now(IST).date()
    last = max((h[-1]["t"] for h in hist.values() if h), default=None)
    start = datetime.strptime(last, "%Y-%m-%d").date() + timedelta(days=1) if last else today - timedelta(days=HISTORY_DAYS)
    days = [start + timedelta(days=i) for i in range((today - start).days + 1)]
    days = [d for d in days if d.weekday() < 5]
    print("fetching %d weekdays from %s%s" % (len(days), start, "" if last else " (first run: building history)"), flush=True)

    results, errors = {}, []
    def job(d):
        try:
            return d, parse_day(d, want)
        except (csv.Error, UnicodeError, ValueError, KeyError) as e:    # one unreadable old file must not stop the run
            print("WARN skipped %s (unreadable file: %s)" % (d, str(e)[:80]), flush=True)
            return d, None
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for n, fut in enumerate(ex.map(job, days), 1):
            try:
                d, rows = fut
                results[d] = rows
            except Exception as e:       # noqa: BLE001
                errors.append(str(e)[:200])
            if n % 100 == 0:
                print("progress %d/%d" % (n, len(days)), flush=True)
    if errors:
        sys.exit("NSE download errors (nothing saved, will retry next run): " + "; ".join(errors[:3]))

    trading = sorted(d for d, r in results.items() if r)
    print("trading days found: %d" % len(trading), flush=True)
    if not trading and not hist:
        sys.exit("No NSE files could be read at all. NSE may be blocking GitHub.")

    for d in trading:
        t = d.strftime("%Y-%m-%d")
        for sym, (o, h, l, c, v, pc) in results[d].items():
            cs = hist.setdefault(sym, [])
            if cs and cs[-1]["t"] >= t:
                continue
            if cs and pc and cs[-1]["c"] > 0:
                ratio = pc / cs[-1]["c"]
                if abs(ratio - 1) > SPLIT_TOL:                # split / bonus / rights: rescale older candles
                    print("adjust %s on %s by %.4f" % (sym, t, ratio))
                    for x in cs:
                        x["o"] *= ratio; x["h"] *= ratio; x["l"] *= ratio; x["c"] *= ratio; x["v"] = x["v"] / ratio
            cs.append({"t": t, "o": o, "h": max(h, o, c), "l": min(l, o, c), "c": c, "v": v})

    cutoff = (today - timedelta(days=HISTORY_DAYS)).strftime("%Y-%m-%d")
    written = []
    for sym, cs in hist.items():
        cs = [x for x in cs if x["t"] >= cutoff]
        if len(cs) < 20:
            continue
        cs = [{"t": x["t"], "o": round(x["o"], 2), "h": round(x["h"], 2), "l": round(x["l"], 2), "c": round(x["c"], 2), "v": int(x["v"])} for x in cs]
        write_json(os.path.join(OUT, file_key(sym) + "_1d.json"), cs[-SCAN_BARS:])
        write_json(os.path.join(OUT, file_key(sym) + "_5y.json"), cs)
        written.append(sym)
    listed = sorted(s for s in stocks if s in written)
    write_json(os.path.join(OUT, "nifty500.json"), listed)
    lastc = max((hist[s][-1]["t"] for s in written), default=None)
    write_json(os.path.join(OUT, "meta.json"), {"updated": datetime.now(IST).strftime("%Y-%m-%d %H:%M IST"), "last_candle": lastc,
                                               "source": "NSE official daily files", "symbols": len(written), "constituents": list_src})
    print("done: %d symbols, last candle %s" % (len(written), lastc))
    if "NIFTY" not in written:
        sys.exit("NIFTY index data missing")

if __name__ == "__main__":
    main()
