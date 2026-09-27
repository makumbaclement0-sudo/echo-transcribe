#!/usr/bin/env python3
"""
Funding-rate carry scanner.

Finds perpetual futures whose funding rate has been positive on *every*
payment over the last N days (default 5), across OKX, Bitget, Gate and
Hyperliquid. For each one it reports the annualised yield, the full payment
history and the projected income of a delta-neutral carry trade
(long spot + short perp, collecting funding) over a hold period (default 40
days) for a given notional size.

Stdlib only, so it runs anywhere Python 3.9+ is installed:

    python scripts/funding_scan.py --size 10000 --days 5 --hold 40
    python scripts/funding_scan.py --size 25000 --json out.json --html out.html
    python scripts/funding_scan.py --venues okx,hyperliquid --min-volume 5e6

Size is the notional of EACH leg (spot bought = perp shorted = size), so the
capital needed is roughly size * (1 + 1/perp_leverage).

The projection holds the observed rate constant. Funding rates mean-revert
and can flip negative, so read the projection as "if the last N days
continue", not as a forecast.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import ssl
import statistics
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

DAY_MS = 86_400_000
HOUR_MS = 3_600_000

# Default taker fees (fraction, VIP 0). The round-trip cost of the carry trade
# is 2 * (perp_fee + spot_fee): open both legs, close both legs.
PERP_TAKER = {"okx": 0.0005, "bitget": 0.0006, "gate": 0.0005, "hyperliquid": 0.00045}
SPOT_TAKER = 0.001

# Spacing between requests per venue (seconds), under each public rate limit.
PACE = {"okx": 0.22, "bitget": 0.1, "gate": 0.1, "hyperliquid": 1.4}

VENUE_LABEL = {"okx": "OKX", "bitget": "Bitget", "gate": "Gate", "hyperliquid": "Hyperliquid"}


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

def _ssl_context() -> ssl.SSLContext:
    cafile = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
    if not cafile and os.path.exists("/root/.ccr/ca-bundle.crt"):
        cafile = "/root/.ccr/ca-bundle.crt"
    return ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()


_CTX = _ssl_context()


class Pacer:
    """Minimal per-venue rate limiter: at most one request every `interval` s."""

    def __init__(self, interval: float):
        self.interval = interval
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self) -> None:
        with self.lock:
            now = time.monotonic()
            if now < self.next_at:
                time.sleep(self.next_at - now)
            self.next_at = max(now, self.next_at) + self.interval


def http_json(url: str, pacer: Pacer, body: dict | None = None, retries: int = 4):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"User-Agent": "funding-scan/1.0", "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    delay = 1.5
    for attempt in range(retries + 1):
        pacer.wait()
        try:
            req = urllib.request.Request(url, data=data, headers=headers)
            with urllib.request.urlopen(req, timeout=20, context=_CTX) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (429, 418) or e.code >= 500:
                if attempt < retries:
                    time.sleep(delay)
                    delay *= 2
                    continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt < retries:
                time.sleep(delay)
                delay *= 2
                continue
            raise


def q(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def norm_coin(sym: str) -> str:
    """Map venue-specific base names (1000PEPE, kPEPE) to a common coin name."""
    s = sym.upper() if not (sym[:1] == "k" and sym[1:2].isupper()) else sym[1:]
    for p in ("1000000", "10000", "1000"):
        if s.startswith(p) and len(s) > len(p):
            return s[len(p):]
    return s


# --------------------------------------------------------------------------- #
# Venue adapters. Each returns:
#   markets(): list of {symbol, coin, volume_usd, current_rate?, interval_h?}
#   history(symbol, start_ms): list of (time_ms, rate) ascending
#   spot_coins(): set of normalised coins with a USDT/USDC spot market
# --------------------------------------------------------------------------- #

class OKX:
    name = "okx"
    base = "https://www.okx.com"

    def __init__(self):
        self.p = Pacer(PACE["okx"])

    def markets(self):
        t = http_json(f"{self.base}/api/v5/market/tickers?instType=SWAP", self.p)["data"]
        inst = http_json(f"{self.base}/api/v5/public/instruments?instType=SWAP", self.p)["data"]
        live = {i["instId"]: i for i in inst if i.get("state") == "live" and i.get("settleCcy") == "USDT"}
        out = []
        for x in t:
            iid = x["instId"]
            if iid not in live:
                continue
            coin = iid.split("-")[0]
            vol = float(x.get("volCcy24h") or 0) * float(x.get("last") or 0)
            out.append({"symbol": iid, "coin": norm_coin(coin), "volume_usd": vol})
        return out

    def history(self, symbol, start_ms):
        rows, after = [], None
        while True:
            url = f"{self.base}/api/v5/public/funding-rate-history?instId={q(symbol)}&limit=100"
            if after:
                url += f"&after={after}"
            d = http_json(url, self.p)["data"]
            if not d:
                break
            rows += [(int(r["fundingTime"]), float(r.get("realizedRate") or r["fundingRate"])) for r in d]
            oldest = int(d[-1]["fundingTime"])
            if oldest < start_ms or len(d) < 100:
                break
            after = oldest
        return sorted(rows)

    def current(self, symbol):
        d = http_json(f"{self.base}/api/v5/public/funding-rate?instId={q(symbol)}", self.p)["data"][0]
        interval_h = (int(d["nextFundingTime"]) - int(d["fundingTime"])) / HOUR_MS
        return float(d["fundingRate"]), interval_h

    def spot_coins(self):
        d = http_json(f"{self.base}/api/v5/public/instruments?instType=SPOT", self.p)["data"]
        return {norm_coin(i["baseCcy"]) for i in d if i.get("quoteCcy") in ("USDT", "USDC") and i.get("state") == "live"}


class Bitget:
    name = "bitget"
    base = "https://api.bitget.com"

    def __init__(self):
        self.p = Pacer(PACE["bitget"])
        self.intervals = {}

    def markets(self):
        t = http_json(f"{self.base}/api/v2/mix/market/tickers?productType=usdt-futures", self.p)["data"]
        c = http_json(f"{self.base}/api/v2/mix/market/contracts?productType=usdt-futures", self.p)["data"]
        meta = {x["symbol"]: x for x in c if x.get("symbolStatus") == "normal"}
        out = []
        for x in t:
            m = meta.get(x["symbol"])
            if not m:
                continue
            ih = float(m.get("fundInterval") or 8)
            self.intervals[x["symbol"]] = ih
            out.append({
                "symbol": x["symbol"], "coin": norm_coin(m["baseCoin"]),
                "volume_usd": float(x.get("usdtVolume") or 0),
                "current_rate": float(x.get("fundingRate") or 0), "interval_h": ih,
            })
        return out

    def history(self, symbol, start_ms):
        rows, page = [], 1
        while True:
            d = http_json(f"{self.base}/api/v2/mix/market/history-fund-rate?symbol={q(symbol)}"
                          f"&productType=usdt-futures&pageSize=100&pageNo={page}", self.p)["data"]
            if not d:
                break
            rows += [(int(r["fundingTime"]), float(r["fundingRate"])) for r in d]
            if int(d[-1]["fundingTime"]) < start_ms or len(d) < 100:
                break
            page += 1
        return sorted(rows)

    def spot_coins(self):
        d = http_json(f"{self.base}/api/v2/spot/public/symbols", self.p)["data"]
        return {norm_coin(x["baseCoin"]) for x in d if x.get("quoteCoin") in ("USDT", "USDC") and x.get("status") == "online"}


class Gate:
    name = "gate"
    base = "https://api.gateio.ws/api/v4"

    def __init__(self):
        self.p = Pacer(PACE["gate"])

    def markets(self):
        t = http_json(f"{self.base}/futures/usdt/tickers", self.p)
        c = http_json(f"{self.base}/futures/usdt/contracts", self.p)
        meta = {x["name"]: x for x in c if not x.get("in_delisting") and x.get("status", "trading") == "trading"}
        out = []
        for x in t:
            m = meta.get(x["contract"])
            if not m:
                continue
            out.append({
                "symbol": x["contract"], "coin": norm_coin(x["contract"].rsplit("_", 1)[0]),
                "volume_usd": float(x.get("volume_24h_quote") or 0),
                "current_rate": float(x.get("funding_rate") or 0),
                "interval_h": int(m.get("funding_interval") or 28800) / 3600,
            })
        return out

    def history(self, symbol, start_ms):
        d = http_json(f"{self.base}/futures/usdt/funding_rate?contract={q(symbol)}"
                      f"&from={start_ms // 1000 - 86400}&limit=1000", self.p)
        return sorted((int(r["t"]) * 1000, float(r["r"])) for r in d)

    def spot_coins(self):
        d = http_json(f"{self.base}/spot/currency_pairs", self.p)
        return {norm_coin(x["base"]) for x in d if x.get("quote") in ("USDT", "USDC") and x.get("trade_status") == "tradable"}


class Hyperliquid:
    name = "hyperliquid"
    url = "https://api.hyperliquid.xyz/info"

    def __init__(self):
        self.p = Pacer(PACE["hyperliquid"])
        self.perp_names = set()

    def markets(self):
        meta, ctxs = http_json(self.url, self.p, {"type": "metaAndAssetCtxs"})
        out = []
        for u, c in zip(meta["universe"], ctxs):
            if u.get("isDelisted"):
                continue
            self.perp_names.add(norm_coin(u["name"]))
            out.append({
                "symbol": u["name"], "coin": norm_coin(u["name"]),
                "volume_usd": float(c.get("dayNtlVlm") or 0),
                "current_rate": float(c.get("funding") or 0), "interval_h": 1.0,
            })
        return out

    def history(self, symbol, start_ms):
        rows, start = [], start_ms - 2 * HOUR_MS
        while True:
            d = http_json(self.url, self.p, {"type": "fundingHistory", "coin": symbol, "startTime": start})
            if not d:
                break
            rows += [(int(r["time"]), float(r["fundingRate"])) for r in d]
            if len(d) < 500:
                break
            start = int(d[-1]["time"]) + 1
        return sorted(rows)

    def spot_coins(self):
        d = http_json(self.url, self.p, {"type": "spotMeta"})
        tokens = {t["index"]: t["name"] for t in d["tokens"]}
        out = set()
        for pair in d["universe"]:
            base, quote = (tokens.get(i, "") for i in pair["tokens"])
            if quote not in ("USDC", "USDT0", "USDH"):
                continue
            out.add(norm_coin(base))
            # Wrapped majors trade as UBTC, UETH, USOL, ...
            if base.startswith("U") and len(base) > 3:
                out.add(norm_coin(base[1:]))
        return out


ADAPTERS = {"okx": OKX, "bitget": Bitget, "gate": Gate, "hyperliquid": Hyperliquid}


# --------------------------------------------------------------------------- #
# Analysis
# --------------------------------------------------------------------------- #

def analyse(history, now_ms, days, min_rate):
    """Return metrics if every payment in the window is > min_rate, else None."""
    start = now_ms - days * DAY_MS
    window = [(t, r) for t, r in history if start < t <= now_ms]
    if len(window) < 2:
        return None, "insufficient history"
    gaps = [b[0] - a[0] for a, b in zip(window, window[1:])]
    interval_h = statistics.median(gaps) / HOUR_MS
    # Require the market to have paid funding across the whole window
    # (newly listed markets would otherwise look artificially clean).
    earlier = [t for t, _ in history if t <= start]
    if not earlier and window[0][0] - start > interval_h * HOUR_MS * 1.5:
        return None, "listed inside window"
    expected = days * 24 / interval_h
    if len(window) < expected * 0.9 - 1:
        return None, "gaps in history"
    if any(r <= min_rate for _, r in window):
        return None, "non-positive payment"

    rates = [r for _, r in window]
    total = sum(rates)
    daily = total / days
    buckets = []
    for d in range(days):
        lo, hi = start + d * DAY_MS, start + (d + 1) * DAY_MS
        buckets.append(sum(r for t, r in window if lo < t <= hi))
    last24 = buckets[-1]
    mean_daily = daily
    return {
        "payments": [[t, r] for t, r in window],
        "n": len(window),
        "interval_h": round(interval_h, 3),
        "total_rate": total,
        "daily_rate": daily,
        "apr": daily * 365,
        "apy": (1 + daily) ** 365 - 1,
        "daily_buckets": buckets,
        "min_daily": min(buckets),
        "max_daily": max(buckets),
        "last24_daily": last24,
        "apr_last24": last24 * 365,
        "apr_min_day": min(buckets) * 365,
        "min_rate": min(rates),
        "max_rate": max(rates),
        "stdev_rate": statistics.pstdev(rates),
        "consistency": (min(buckets) / mean_daily) if mean_daily > 0 else 0,
        "trend": (last24 / mean_daily - 1) if mean_daily > 0 else 0,
    }, None


def project(m, size, hold, rt_fee):
    fees = size * rt_fee
    out = {}
    for key, daily in (("base", m["daily_rate"]), ("conservative", m["min_daily"]), ("recent", m["last24_daily"])):
        gross = size * daily * hold
        out[key] = {"gross": gross, "net": gross - fees}
    out["fees"] = fees
    out["breakeven_days"] = rt_fee / m["daily_rate"] if m["daily_rate"] > 0 else math.inf
    return out


def scan_venue(key, args, now_ms, log):
    ad = ADAPTERS[key]()
    stats = {"venue": key, "markets": 0, "scanned": 0, "passed": 0, "rejected": {}, "error": None}
    results, spot = [], set()
    try:
        mk = ad.markets()
        stats["markets"] = len(mk)
        try:
            spot = ad.spot_coins()
        except Exception as e:  # spot list is nice-to-have
            spot = set()
            log(f"[{key}] spot list failed: {e}")
        cands = [m for m in mk if m["volume_usd"] >= args.min_volume]
        log(f"[{key}] {len(mk)} USDT perps, {len(cands)} above ${args.min_volume:,.0f} 24h volume")
        start_ms = now_ms - args.days * DAY_MS
        for i, m in enumerate(cands, 1):
            try:
                hist = ad.history(m["symbol"], start_ms)
            except Exception as e:
                stats["rejected"]["fetch error"] = stats["rejected"].get("fetch error", 0) + 1
                log(f"[{key}] {m['symbol']}: {e}")
                continue
            stats["scanned"] += 1
            met, why = analyse(hist, now_ms, args.days, args.min_rate)
            if not met:
                stats["rejected"][why] = stats["rejected"].get(why, 0) + 1
                continue
            if met["apr"] < args.min_apr:
                stats["rejected"]["below min APR"] = stats["rejected"].get("below min APR", 0) + 1
                continue
            cur, cur_ih = m.get("current_rate"), m.get("interval_h")
            if key == "okx":
                try:
                    cur, cur_ih = ad.current(m["symbol"])
                except Exception:
                    cur, cur_ih = None, None
            rt_fee = 2 * ((args.perp_fee if args.perp_fee is not None else PERP_TAKER[key]) + args.spot_fee)
            res = {
                "venue": key, "venue_label": VENUE_LABEL[key], "symbol": m["symbol"], "coin": m["coin"],
                "volume_usd": m["volume_usd"],
                "current_rate": cur, "current_interval_h": cur_ih,
                "current_apr": (cur * 24 / cur_ih * 365) if (cur is not None and cur_ih) else None,
                "spot_same_venue": m["coin"] in spot,
                "rt_fee": rt_fee,
                **met,
            }
            res["projection"] = project(res, args.size, args.hold, rt_fee)
            results.append(res)
            stats["passed"] += 1
            if i % 25 == 0:
                log(f"[{key}] {i}/{len(cands)} checked, {stats['passed']} pass")
        log(f"[{key}] done: {stats['passed']} of {stats['scanned']} consistently positive")
    except Exception as e:
        stats["error"] = str(e)
        log(f"[{key}] FAILED: {e}")
    return results, stats, spot


def run(args):
    now_ms = int(time.time() * 1000)
    lock = threading.Lock()

    def log(msg):
        if not args.quiet:
            with lock:
                print(msg, file=sys.stderr, flush=True)

    venues = [v.strip() for v in args.venues.split(",") if v.strip()]
    for v in venues:
        if v not in ADAPTERS:
            sys.exit(f"unknown venue {v!r}; choose from {', '.join(ADAPTERS)}")
    with ThreadPoolExecutor(len(venues)) as ex:
        outs = list(ex.map(lambda v: scan_venue(v, args, now_ms, log), venues))

    results, stats, spot_by_venue = [], [], {}
    for (r, s, spot), v in zip(outs, venues):
        results += r
        stats.append(s)
        spot_by_venue[v] = spot
    for r in results:
        r["spot_venues"] = [VENUE_LABEL[v] for v in venues if r["coin"] in spot_by_venue[v]]
    results.sort(key=lambda r: r["apr"], reverse=True)
    return {
        "generated_at": datetime.fromtimestamp(now_ms / 1000, timezone.utc).isoformat(timespec="seconds"),
        "now_ms": now_ms,
        "params": {
            "size": args.size, "days": args.days, "hold": args.hold,
            "min_volume": args.min_volume, "min_rate": args.min_rate, "min_apr": args.min_apr,
            "spot_fee": args.spot_fee, "perp_fee": {v: (args.perp_fee if args.perp_fee is not None else PERP_TAKER[v]) for v in venues},
        },
        "venues": stats,
        "results": results,
    }


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #

def pct(x, d=2):
    return f"{x * 100:.{d}f}%"


def print_table(report, top):
    p = report["params"]
    rows = report["results"][:top]
    print(f"\nConsistently positive funding, last {p['days']}d  |  size ${p['size']:,.0f}  |  hold {p['hold']}d"
          f"  |  {report['generated_at']}\n")
    hdr = f"{'#':>3} {'Coin':<10} {'Venue':<11} {'APR 5d':>8} {'APR 24h':>8} {'APR low':>8} {'Pays':>5} {'Vol 24h':>10} " \
          f"{'Gross':>9} {'Net':>9} {'B/E d':>6}  Spot"
    print(hdr)
    print("-" * len(hdr))
    for i, r in enumerate(rows, 1):
        pr = r["projection"]
        print(f"{i:>3} {r['coin'][:10]:<10} {r['venue_label']:<11} {pct(r['apr'], 1):>8} {pct(r['apr_last24'], 1):>8} "
              f"{pct(r['apr_min_day'], 1):>8} {r['n']:>5} {r['volume_usd'] / 1e6:>9.1f}M "
              f"{pr['base']['gross']:>9,.0f} {pr['base']['net']:>9,.0f} {pr['breakeven_days']:>6.1f}  "
              f"{','.join(r['spot_venues']) or '-'}")
    print()
    for s in report["venues"]:
        rej = ", ".join(f"{k}: {v}" for k, v in sorted(s["rejected"].items(), key=lambda kv: -kv[1]))
        print(f"{VENUE_LABEL[s['venue']]:<11} markets {s['markets']:>4}  scanned {s['scanned']:>4}  passed {s['passed']:>3}"
              f"{'  ERROR ' + s['error'] if s['error'] else ''}  ({rej})")


def write_html(report, path, fragment):
    tpl_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "funding_report.html")
    with open(tpl_path, encoding="utf-8") as f:
        tpl = f.read()
    payload = json.dumps(report, separators=(",", ":")).replace("</", "<\\/")
    html = tpl.replace("/*__FUNDING_DATA__*/null", payload)
    if not fragment:
        html = ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
                '</head><body>\n' + html + '\n</body></html>\n')
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--size", type=float, default=10_000, help="notional per leg in USD (default 10000)")
    ap.add_argument("--days", type=int, default=5, help="lookback window in days (default 5)")
    ap.add_argument("--hold", type=int, default=40, help="projected hold period in days (default 40)")
    ap.add_argument("--venues", default="okx,bitget,gate,hyperliquid")
    ap.add_argument("--min-volume", type=float, default=1_000_000, help="min 24h perp volume in USD (default 1e6)")
    ap.add_argument("--min-rate", type=float, default=0.0, help="every payment must exceed this rate (default 0)")
    ap.add_argument("--min-apr", type=float, default=0.0, help="drop results below this APR, e.g. 0.05 = 5%%")
    ap.add_argument("--spot-fee", type=float, default=SPOT_TAKER, help="spot taker fee per side (default 0.001)")
    ap.add_argument("--perp-fee", type=float, default=None, help="override perp taker fee per side for all venues")
    ap.add_argument("--top", type=int, default=40, help="rows to print (default 40)")
    ap.add_argument("--json", help="write the full report (incl. payment history) to this JSON file")
    ap.add_argument("--html", help="write an interactive HTML report to this file")
    ap.add_argument("--fragment", action="store_true", help="write the HTML without <html>/<head>/<body> wrapper")
    ap.add_argument("--from-json", help="skip the scan and re-render a report saved earlier with --json")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if args.from_json:
        with open(args.from_json, encoding="utf-8") as f:
            report = json.load(f)
    else:
        report = run(args)
    print_table(report, args.top)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=1)
    if args.html:
        write_html(report, args.html, args.fragment)


if __name__ == "__main__":
    main()
