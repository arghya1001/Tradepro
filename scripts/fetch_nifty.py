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
