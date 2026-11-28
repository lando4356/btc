#!/usr/bin/env python3
"""Strike-cross lead test on logged ticks (Coinbase BTC vs Kalshi KXBTC15M).

Live ticks (bot/live) have a trustworthy Kalshi order book and are used for
everything: settlement hit rate, after-fee P&L, lead time, swings.

Archive ticks (bot/archive) used stale Kalshi list prices, so they are used
ONLY for settlement hit rate and raw-vs-gap-corrected false-cross counts
(BTC vs official result), never for trade P&L or lead time.

Usage: python3 tools/strike-cross.py
"""
from __future__ import annotations
import csv, json, math, os, statistics, time, urllib.request
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CACHE = HERE.parent / "data" / "results-cache.json"
OUT = HERE.parent / "data" / "strike-cross-results.json"
API = "https://api.elections.kalshi.com/trade-api/v2"

# ---------- fees (same formula as src/fees.mjs) ----------
def taker_fee_dollars(price_cents, count=1):
    if count <= 0 or price_cents is None: return 0.0
    p = price_cents / 100.0
    raw = 0.07 * count * p * (1.0 - p)
    return math.ceil(raw / 0.0001 - 1e-9) * 0.0001

def mean_sd(a):
    a = [x for x in a if x is not None and x == x]
    n = len(a)
    if n == 0: return {"n": 0, "mean": None, "sd": None, "se": None}
    m = sum(a) / n
    var = sum((x - m) ** 2 for x in a) / (n - 1) if n > 1 else 0.0
    sd = math.sqrt(var)
    return {"n": n, "mean": m, "sd": sd, "se": sd / math.sqrt(n) if n else None}

def median(a):
    a = [x for x in a if x is not None]
    if not a: return None
    s = sorted(a); mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2

def pct(k, n):
    return None if not n else 100.0 * k / n

# ---------- load ticks ----------
def load_ticks(folder):
    rows = []
    for f in sorted(Path(folder).glob("ticks-*.csv")):
        with open(f, newline="") as fh:
            for r in csv.DictReader(fh):
                try:
                    o = {k: (r[k] if k == "ticker" else float(r[k])) for k in r}
                    o["t"] = int(o["t"]); o["closeTs"] = int(o["closeTs"])
                    if o["ticker"] and o["btc"] > 0 and math.isfinite(o["yesBid"]) and math.isfinite(o["noBid"]):
                        rows.append(o)
                except (KeyError, ValueError):
                    continue
    rows.sort(key=lambda x: x["t"])
    by = defaultdict(list)
    for r in rows:
        by[r["ticker"]].append(r)
    return by

def load_cache():
    try:
        return json.loads(CACHE.read_text())
    except Exception:
        return {}

def fetch_missing(tickers, cache):
    missing = [t for t in tickers if cache.get(t, {}).get("result") not in ("yes", "no")]
    print(f"Official results: {len(tickers) - len(missing)} cached, {len(missing)} to fetch")
    for i, tk in enumerate(missing):
        try:
            req = urllib.request.Request(f"{API}/markets/{tk}", headers={"Accept": "application/json", "User-Agent": "kalshi-bot-v48-research"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                m = json.loads(resp.read().decode()).get("market") or {}
            ev = m.get("expiration_value")
            cache[tk] = {
                "result": m.get("result") or None,
                "expirationValue": None if ev is None else float(ev),
                "strike": None if m.get("floor_strike") is None else float(m["floor_strike"]),
                "closeMs": None if not m.get("close_time") else int(__import__("datetime").datetime.fromisoformat(m["close_time"].replace("Z", "+00:00")).timestamp() * 1000),
            }
        except Exception as e:
            print("  fetch failed", tk, e)
        if (i + 1) % 20 == 0:
            print(f"  fetched {i+1}/{len(missing)}")
        time.sleep(0.06)
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, indent=1))
    return cache

# ---------- window helpers ----------
BUCKETS = [
    (780, 900, "13–15 min"),
    (600, 780, "10–13 min"),
    (360, 600, "6–10 min"),
    (180, 360, "3–6 min"),
    (60, 180, "1–3 min"),
    (30, 60, "30–60 s"),
    (0, 30, "0–30 s"),
]

def bucket_of(left):
    for a, b, name in BUCKETS:
        if a <= left < b or (b == 900 and left == 900):
            return name
    return "other"

def sign_vs(price, strike, eps=0.0):
    d = price - strike
    if d > eps: return 1
    if d < -eps: return -1
    return 0

def find_crosses(prices, strikes, times, eps=0.0):
    """Return list of (index, side) where side is +1 (crossed up through strike) or -1 (down)."""
    out = []
    prev = 0
    for i, (p, k) in enumerate(zip(prices, strikes)):
        s = sign_vs(p, k, eps)
        if s != 0:
            if prev != 0 and s != prev:
                out.append((i, s))
            prev = s
    return out

def mid_yes(r):
    if r["yesBid"] is None or r["yesAsk"] is None: return None
    return (r["yesBid"] + r["yesAsk"]) / 2

def valid_ask(ask, lo=5, hi=95):
    return ask is not None and lo <= ask <= hi

def hold_pnl(won, ask):
    """Dollars per 1 contract, hold to settlement, taker fee on buy only."""
    if not valid_ask(ask): return None
    return (1.0 if won else 0.0) - ask / 100.0 - taker_fee_dollars(ask, 1)

def swing_pnl(ask, bid):
    """Dollars per 1 contract, buy at ask, sell at bid, taker fees both legs."""
    if not valid_ask(ask) or bid is None or bid < 1 or bid > 99: return None
    return bid / 100.0 - ask / 100.0 - taker_fee_dollars(ask, 1) - taker_fee_dollars(bid, 1)

def summarize_trades(pnls, won_flags=None):
    m = mean_sd(pnls)
    wins = sum(1 for p in pnls if p > 0) if won_flags is None else sum(won_flags)
    out = {
        "n": m["n"],
        "wins": wins,
        "win_rate": None if not m["n"] else wins / m["n"],
        "pnl": m["mean"] * m["n"] if m["n"] else 0.0,          # total $ for 1 contract each
        "per_trade": m["mean"],
        "t": None if not m["se"] or m["se"] == 0 else m["mean"] / m["se"],
    }
    return out

def fmt_trade(s):
    if not s or s["n"] == 0:
        return "no trades"
    wr = 100 * s["win_rate"]
    per = 100 * s["per_trade"]  # cents
    t = "n/a" if s["t"] is None else f"{s['t']:.2f}"
    return f"n={s['n']}, won {s['wins']} ({wr:.1f}%), P&L ${s['pnl']:+.2f} ({per:+.1f}¢/contract, t {t})"

# ---------- build per-window series ----------
def window_series(ts):
    """Add left, mid, and a per-second BTC map for averages."""
    close = int(ts[0]["closeTs"])
    for r in ts:
        r["left"] = (close - r["t"]) / 1000.0
        r["mid"] = mid_yes(r)
    sec = {}
    for r in ts:
        sec[r["t"] // 1000] = r["btc"]
    return sec

def avg_secs(secmap, a, b, min_frac=0.6):
    if b <= a: return None
    s = n = have = 0
    c = None
    for k in range(a, b):
        if k in secmap:
            c = secmap[k]; have += 1
        if c is not None:
            s += c; n += 1
    if n and have >= min_frac * (b - a):
        return s / n
    return None

def trailing_avg(ts, i, seconds=5):
    t1 = ts[i]["t"]
    t0 = t1 - seconds * 1000
    vals = [r["btc"] for r in ts[: i + 1] if r["t"] >= t0]
    return sum(vals) / len(vals) if vals else ts[i]["btc"]

def expected_settlement(ts, i, secmap, gap=0.0):
    """Expected 60s settlement average at tick i, using known last-minute seconds + current (gap-corrected) price."""
    close_sec = ts[0]["closeTs"] // 1000
    start_avg = close_sec - 60
    now_sec = ts[i]["t"] // 1000
    price = ts[i]["btc"] + gap
    if now_sec < start_avg:
        return price  # the settlement minute hasn't started; expectation ≈ current (corrected) spot
    known = avg_secs(secmap, start_avg, min(now_sec, close_sec), min_frac=0.0)
    known_secs = max(0, min(now_sec, close_sec) - start_avg)
    left = max(0, close_sec - now_sec)
    if known is None:
        known, known_secs = price, 0
    # known is raw Coinbase average; add gap to the known part too
    return ((known + gap) * known_secs + price * left) / 60.0

# ---------- main analysis on one dataset of windows ----------
def analyze_live(windows, gap_close_list):
    """windows: list of dicts {tk, ts, r} chronological. gap_close_list filled as we go (walk-forward)."""
    events = []  # one record per cross, various price series tagged
    series_names = ["raw_spot", "corr_spot", "raw_avg5", "corr_avg5"]

    for wi, w in enumerate(windows):
        ts, r = w["ts"], w["r"]
        strike = r.get("strike") or ts[0]["strike"]
        y = 1 if r["result"] == "yes" else 0
        secmap = window_series(ts)
        close_sec = ts[0]["closeTs"] // 1000
        # walk-forward gap: mean of earlier close samples only (no leakage)
        gm = mean_sd(gap_close_list)
        gap = gm["mean"] if gm["n"] >= 5 else 0.0  # until we have 5 measurements, treat as uncorrected
        gap_n = gm["n"]

        # price series at each tick
        raw_spot = [t["btc"] for t in ts]
        corr_spot = [t["btc"] + gap for t in ts]
        raw_avg5 = [trailing_avg(ts, i, 5) for i in range(len(ts))]
        corr_avg5 = [a + gap for a in raw_avg5]
        strikes = [strike] * len(ts)
        times = [t["t"] for t in ts]

        series = {
            "raw_spot": raw_spot,
            "corr_spot": corr_spot,
            "raw_avg5": raw_avg5,
            "corr_avg5": corr_avg5,
        }
        # also fixed-offset robustness series (not walk-forward)
        for off in (4.0, 4.7, 5.0):
            series[f"spot_plus_{off:g}"] = [t["btc"] + off for t in ts]

        crosses_by = {name: find_crosses(series[name], strikes, times) for name in series}

        def add_events(name, crosses, first_only=False):
            seen = set()
            for i, side in crosses:
                kind = "first" if side not in seen else "later"
                seen.add(side)
                if first_only and kind != "first":
                    continue
                ev = build_event(w, ts, i, side, name, y, strike, gap, gap_n, kind)
                if ev:
                    events.append(ev)

        for name, crosses in crosses_by.items():
            add_events(name, crosses, first_only=False)

        # after finishing the window, record the close gap (for later windows)
        cavg = avg_secs(secmap, close_sec - 60, close_sec)
        if cavg and r.get("expirationValue"):
            gap_close_list.append(r["expirationValue"] - cavg)

    return events

def next_tick(ts, i):
    return ts[i + 1] if i + 1 < len(ts) else None

def tick_at_or_after(ts, t_ms):
    for j, r in enumerate(ts):
        if r["t"] >= t_ms:
            return j, r
    return None, None

def build_event(w, ts, i, side, series, y, strike, gap, gap_n, kind):
    r0 = ts[i]
    nxt = next_tick(ts, i)
    up = side == 1
    # fills one tick late
    fill = nxt or r0
    ask = fill["yesAsk"] if up else fill["noAsk"]
    bid = fill["yesBid"] if up else fill["noBid"]  # not used for entry
    mid0 = r0["mid"]
    won = (y == 1) if up else (y == 0)
    # already reflected? Kalshi mid already on that side of 50
    if mid0 is None:
        already50 = None
        already10 = None
        mid_side = None
    else:
        already50 = (mid0 >= 50) if up else (mid0 <= 50)
        # mid already at least 10c into the side (60 / 40)
        already10 = (mid0 >= 60) if up else (mid0 <= 40)
        mid_side = 1 if mid0 > 50 else (-1 if mid0 < 50 else 0)

    # lead times: from the cross tick, until mid crosses 50 or moves 10c
    lead50 = lead10 = None
    reached50 = already50
    reached10 = False
    if mid0 is not None:
        if already50:
            lead50 = 0.0
        for r in ts[i + 1:]:
            m = r["mid"]
            if m is None: continue
            dt = (r["t"] - r0["t"]) / 1000.0
            if lead50 is None and ((up and m >= 50) or ((not up) and m <= 50)):
                lead50 = dt
                reached50 = True
            if (up and m - mid0 >= 10) or ((not up) and mid0 - m >= 10):
                lead10 = dt
                reached10 = True
                if lead50 is not None:
                    break

    hp = hold_pnl(won, ask) if nxt else None

    # swing exits from the fill tick
    swings = {}
    if nxt is not None and valid_ask(ask):
        fill_i = i + 1
        mid_at_fill = nxt["mid"] if nxt["mid"] is not None else mid0
        # time-based: N seconds after the CROSS (signal)
        for N in (3, 5, 10, 20, 30):
            swings[f"time_{N}s"] = swing_exit(ts, fill_i, up, ask, r0["t"] + N * 1000, y, won)
        # mid-move: Kalshi mid has moved X cents from mid at the cross, in the signal direction
        for X in (5, 10, 15):
            def mid_moved(r, X=X, mid0=mid0, up=up):
                if mid0 is None or r["mid"] is None: return False
                return (r["mid"] - mid0 >= X) if up else (mid0 - r["mid"] >= X)
            swings[f"mid_{X}c"] = swing_exit_cond(ts, fill_i, up, ask, mid_moved, y, won)
        # mid crosses 50 (Kalshi "catches up" through even)
        def mid_thru_50(r, up=up):
            if r["mid"] is None: return False
            return (r["mid"] >= 50) if up else (r["mid"] <= 50)
        swings["mid_cross_50"] = swing_exit_cond(ts, fill_i, up, ask, mid_thru_50, y, won, skip_if=already50)

    return {
        "tk": w["tk"], "t": r0["t"], "left": r0["left"], "bucket": bucket_of(r0["left"]),
        "side": "up" if up else "down", "series": series, "kind": kind,
        "y": y, "won_settle": won, "strike": strike, "btc": r0["btc"],
        "gap": gap, "gap_n": gap_n, "px": (r0["btc"] + gap) if series.startswith("corr") or series.startswith("spot_plus") else r0["btc"],
        "mid0": mid0, "ask": ask, "spread": (fill["yesAsk"] - fill["yesBid"]) if nxt else None,
        "already50": already50, "already10": already10, "mid_side": mid_side,
        "lead50": lead50, "lead10": lead10, "reached50": reached50, "reached10": reached10,
        "hold_pnl": hp, "has_fill": nxt is not None and valid_ask(ask),
        "swings": swings, "win_i": w["wi"],
    }

def swing_exit(ts, fill_i, up, ask, target_t, y, won):
    """Exit at the first tick at or after target_t, fill one tick later at the bid. If not enough time, sell last bid or settle."""
    j, _ = tick_at_or_after(ts, target_t)
    return realize_exit(ts, fill_i, j, up, ask, y, won)

def swing_exit_cond(ts, fill_i, up, ask, cond, y, won, skip_if=False):
    if skip_if:
        return {"status": "already_priced", "pnl": None, "won": None, "hold_secs": None}
    j = None
    for k in range(fill_i + 1, len(ts)):  # condition must appear after the fill
        if cond(ts[k]):
            j = k
            break
    return realize_exit(ts, fill_i, j, up, ask, y, won)

def realize_exit(ts, fill_i, j, up, ask, y, won):
    """j is the tick where the exit condition is first true; fill sell on j+1. None = never, use last bid if >=1s of book left, else settle."""
    close = ts[0]["closeTs"]
    def bid_of(r):
        return r["yesBid"] if up else r["noBid"]

    if j is not None:
        fill_e = next_tick(ts, j) or ts[j]
        # if that fill would be after close, fall through
        if fill_e["t"] < close - 200:
            bid = bid_of(fill_e)
            pnl = swing_pnl(ask, bid)
            if pnl is not None:
                hold = (fill_e["t"] - ts[fill_i]["t"]) / 1000.0
                return {"status": "exit", "pnl": pnl, "won": pnl > 0, "hold_secs": hold, "bid": bid}
    # no timely exit: try last bid at least 1s before close
    last = None
    for r in reversed(ts):
        if r["t"] <= close - 1000 and r["t"] > ts[fill_i]["t"]:
            last = r; break
    if last is not None and bid_of(last) >= 1:
        pnl = swing_pnl(ask, bid_of(last))
        if pnl is not None:
            return {"status": "eod_bid", "pnl": pnl, "won": pnl > 0, "hold_secs": (last["t"] - ts[fill_i]["t"]) / 1000.0, "bid": bid_of(last)}
    # hold to settlement
    hp = hold_pnl(won, ask)
    return {"status": "settled", "pnl": hp, "won": won if hp is not None else None, "hold_secs": (close - ts[fill_i]["t"]) / 1000.0, "bid": 100 if won else 0}

# ---------- reporting ----------
def filter_ev(events, series, first_only=True, surprise=False, min_left=0, max_left=10**9, half=None, n_windows=None):
    out = []
    for e in events:
        if e["series"] != series: continue
        if first_only and e["kind"] != "first": continue
        if surprise and e["already50"] is not False: continue  # only when Kalshi mid was still on the other side of 50 (or exactly 50 excluded)
        if not (min_left <= e["left"] < max_left): continue
        if half == 1 and n_windows is not None and e["win_i"] >= n_windows // 2: continue
        if half == 2 and n_windows is not None and e["win_i"] < n_windows // 2: continue
        out.append(e)
    return out

def settle_stats(evs):
    n = len(evs)
    w = sum(1 for e in evs if e["won_settle"])
    return {"n": n, "wins": w, "win_rate": None if not n else w / n}

def hold_stats(evs):
    pnls, flags = [], []
    already = 0
    for e in evs:
        if e["hold_pnl"] is None: continue
        pnls.append(e["hold_pnl"]); flags.append(1 if e["won_settle"] else 0)
        if e["already50"]: already += 1
    s = summarize_trades(pnls, flags)
    s["already50"] = already
    s["already50_frac"] = None if not s["n"] else already / s["n"]
    return s

def swing_stats(evs, key):
    pnls, flags, statuses = [], [], defaultdict(int)
    holds = []
    for e in evs:
        sw = e.get("swings") or {}
        x = sw.get(key)
        if not x or x.get("pnl") is None:
            if x: statuses[x.get("status") or "none"] += 1
            continue
        pnls.append(x["pnl"]); flags.append(1 if x["won"] else 0)
        statuses[x["status"]] += 1
        if x.get("hold_secs") is not None: holds.append(x["hold_secs"])
    s = summarize_trades(pnls, flags)
    s["statuses"] = dict(statuses)
    s["median_hold_s"] = median(holds)
    return s

def lead_stats(evs):
    # among crosses that were NOT already past 50, median seconds until mid crosses 50 / moves 10c
    wait50 = [e["lead50"] for e in evs if e["already50"] is False and e["lead50"] is not None]
    never50 = sum(1 for e in evs if e["already50"] is False and not e["reached50"])
    wait10 = [e["lead10"] for e in evs if e["lead10"] is not None]
    never10 = sum(1 for e in evs if not e["reached10"])
    already = sum(1 for e in evs if e["already50"] is True)
    n = len(evs)
    return {
        "n": n,
        "already50": already,
        "already50_frac": None if not n else already / n,
        "already10": sum(1 for e in evs if e["already10"] is True),
        "median_lead50_s_if_not_already": median(wait50),
        "n_lead50": len(wait50),
        "never_reached_50": never50,
        "median_lead10_s": median(wait10),
        "n_lead10": len(wait10),
        "never_moved_10c": never10,
    }

def false_cross_counts(events, raw_name, corr_name, first_only=True):
    """Same-window first (or all) crosses: how often raw and corrected disagree."""
    by = defaultdict(lambda: {"raw": [], "corr": []})
    for e in events:
        if first_only and e["kind"] != "first": continue
        if e["series"] == raw_name:
            by[e["tk"]]["raw"].append(e)
        elif e["series"] == corr_name:
            by[e["tk"]]["corr"].append(e)
    raw_only = corr_only = both_same = both_diff = neither = 0
    raw_only_won = corr_only_won = both_same_won = 0
    n_win = 0
    for tk, d in by.items():
        n_win += 1
        # first cross in time for each
        r = min(d["raw"], key=lambda e: e["t"]) if d["raw"] else None
        c = min(d["corr"], key=lambda e: e["t"]) if d["corr"] else None
        if r and c:
            if r["side"] == c["side"]:
                both_same += 1
                both_same_won += int(r["won_settle"])
            else:
                both_diff += 1
        elif r and not c:
            raw_only += 1
            raw_only_won += int(r["won_settle"])
        elif c and not r:
            corr_only += 1
            corr_only_won += int(c["won_settle"])
        else:
            neither += 1
    return {
        "windows_with_any": n_win,
        "both_same_side": both_same, "both_same_won": both_same_won,
        "both_opposite_side": both_diff,
        "raw_only": raw_only, "raw_only_won": raw_only_won,
        "corr_only": corr_only, "corr_only_won": corr_only_won,
        "neither": neither,
    }

def print_block(title):
    print("\n" + title)
    print("-" * len(title))

def report_series(label, evs, n_windows, do_swings=True):
    st = settle_stats(evs)
    ho = hold_stats(evs)
    ld = lead_stats(evs)
    wr = "n/a" if not st["n"] else f"{100*st['win_rate']:.1f}%"
    print(f"\n{label}")
    print(f"  Settlement of the crossed side: {st['wins']}/{st['n']} = {wr}")
    al = "n/a" if ld["already50_frac"] is None else f"{100*ld['already50_frac']:.1f}%"
    print(f"  Kalshi mid already on that side of 50¢ at the cross: {ld['already50']}/{ld['n']} = {al}"
          + (f"; already ≥10¢ past 50: {ld['already10']}/{ld['n']}" if ld["n"] else ""))
    if ld["n_lead50"]:
        print(f"  When it was NOT already past 50¢: median time until Kalshi mid crossed 50¢ = {ld['median_lead50_s_if_not_already']:.1f}s "
              f"(n={ld['n_lead50']}; never reached 50: {ld['never_reached_50']})")
    else:
        print(f"  When it was NOT already past 50¢: mid never crossed 50 after the signal in this set (never={ld['never_reached_50']})")
    if ld["n_lead10"]:
        print(f"  Median time until Kalshi mid moved 10¢ in the signal direction: {ld['median_lead10_s']:.1f}s "
              f"(n={ld['n_lead10']}; never moved 10¢: {ld['never_moved_10c']})")
    print(f"  Hold to settlement, buy at next tick's ask, after fees: {fmt_trade(ho)}")

    # halves
    for half, name in ((1, "first half of windows"), (2, "second half of windows")):
        evh = [e for e in evs if (e["win_i"] < n_windows // 2) == (half == 1)]
        hs = hold_stats(evh)
        print(f"    {name}: {fmt_trade(hs)}")

    # buckets
    print("  By time left in the window (hold-to-settlement, after fees):")
    for a, b, name in BUCKETS:
        evb = [e for e in evs if a <= e["left"] < b or (b == 900 and e["left"] == 900)]
        if not evb: 
            print(f"    {name}: no crosses")
            continue
        sb, hb, lb = settle_stats(evb), hold_stats(evb), lead_stats(evb)
        lead = "n/a" if lb["median_lead50_s_if_not_already"] is None else f"{lb['median_lead50_s_if_not_already']:.0f}s"
        alr = "n/a" if lb["already50_frac"] is None else f"{100*lb['already50_frac']:.0f}%"
        print(f"    {name}: settle {sb['wins']}/{sb['n']}"
              + (f" ({100*sb['win_rate']:.0f}%)" if sb["n"] else "")
              + f", already at 50: {alr}, median lead (if not already): {lead}; {fmt_trade(hb)}")

    if do_swings and evs:
        print("  Swing trades (buy next-tick ask, sell bid, taker fees both legs):")
        keys = [f"time_{n}s" for n in (3, 5, 10, 20, 30)] + [f"mid_{x}c" for x in (5, 10, 15)] + ["mid_cross_50"]
        for key in keys:
            s = swing_stats(evs, key)
            extra = ""
            if s.get("median_hold_s") is not None:
                extra += f", median hold {s['median_hold_s']:.0f}s"
            if s.get("statuses"):
                extra += f", exits {s['statuses']}"
            print(f"    {key}: {fmt_trade(s)}{extra}")
            for half, name in ((1, "1st half"), (2, "2nd half")):
                evh = [e for e in evs if (e["win_i"] < n_windows // 2) == (half == 1)]
                sh = swing_stats(evh, key)
                print(f"      {name}: {fmt_trade(sh)}")

def archive_settle_only(windows, gap_prior):
    """BTC-only first-cross vs official settlement; no Kalshi P&L."""
    recs = []
    gaps = list(gap_prior)
    for wi, w in enumerate(windows):
        ts, r = w["ts"], w["r"]
        strike = r.get("strike") or ts[0]["strike"]
        y = 1 if r["result"] == "yes" else 0
        secmap = window_series(ts)
        gm = mean_sd(gaps)
        gap = gm["mean"] if gm["n"] >= 5 else (gap_prior[-1] if gap_prior else 0.0)
        raw = [t["btc"] for t in ts]
        corr = [t["btc"] + gap for t in ts]
        for name, px in (("raw_spot", raw), ("corr_spot", corr)):
            crosses = find_crosses(px, [strike] * len(ts), [t["t"] for t in ts])
            first = {}
            for i, side in crosses:
                if side in first: continue
                first[side] = i
                up = side == 1
                recs.append({
                    "tk": w["tk"], "series": name, "kind": "first", "side": "up" if up else "down",
                    "won_settle": (y == 1) if up else (y == 0),
                    "left": ts[i]["left"], "win_i": wi, "t": ts[i]["t"],
                    "already50": None, "hold_pnl": None, "swings": {}, "lead50": None, "lead10": None,
                    "already10": None, "reached50": None, "reached10": None,
                })
        close_sec = ts[0]["closeTs"] // 1000
        cavg = avg_secs(secmap, close_sec - 60, close_sec)
        if cavg and r.get("expirationValue"):
            gaps.append(r["expirationValue"] - cavg)
    return recs, gaps

def main():
    print("Loading ticks…")
    live_by = load_ticks(REPO / "bot/live")
    arch_dirs = list((REPO / "bot/archive").iterdir())
    arch_by = defaultdict(list)
    for d in arch_dirs:
        if d.is_dir():
            part = load_ticks(d)
            # skip overlapping tickers already in live; archive Kalshi books are stale anyway
            for k, v in part.items():
                if k not in live_by:
                    arch_by[k].extend(v)
    for k in arch_by:
        arch_by[k].sort(key=lambda x: x["t"])

    cache = load_cache()
    all_tk = list(live_by.keys()) + list(arch_by.keys())
    cache = fetch_missing(all_tk, cache)

    def make_windows(by):
        out = []
        for tk, ts in by.items():
            r = cache.get(tk)
            if not r or r.get("result") not in ("yes", "no"): continue
            if len(ts) < 300: continue
            out.append({"tk": tk, "ts": ts, "r": r, "close": ts[0]["closeTs"]})
        out.sort(key=lambda w: w["close"])
        for i, w in enumerate(out):
            w["wi"] = i
        return out

    live = make_windows(live_by)
    arch = make_windows(arch_by)
    print(f"Live windows with official results: {len(live)}  "
          f"({__import__('datetime').datetime.utcfromtimestamp(live[0]['ts'][0]['t']/1000).isoformat()}Z → "
          f"{__import__('datetime').datetime.utcfromtimestamp(live[-1]['ts'][-1]['t']/1000).isoformat()}Z)")
    print(f"Archive windows (BTC vs settlement only; Kalshi quotes were stale): {len(arch)}")

    # measure close gap on live (and print once)
    gap_all = []
    for w in live:
        secmap = window_series(w["ts"])
        close_sec = w["ts"][0]["closeTs"] // 1000
        cavg = avg_secs(secmap, close_sec - 60, close_sec)
        if cavg and w["r"].get("expirationValue"):
            gap_all.append(w["r"]["expirationValue"] - cavg)
    g = mean_sd(gap_all)
    print(f"\nMeasured gap (official BRTI 60s average minus our Coinbase 60s average), one sample per window:")
    print(f"  mean ${g['mean']:.2f}, sd ${g['sd']:.2f}, n={g['n']}")
    print("  Walk-forward correction uses only earlier windows (0 until 5 samples).")
    print("  Note: these logs contain Coinbase only — not the live multi-exchange v48 index.")
    print("  Archive runs used stale Kalshi list prices (~28s refresh); they are not used for P&L or lead time.")

    gap_wf = []
    events = analyze_live(live, gap_wf)
    nW = len(live)

    # How many windows even had a first cross?
    def windows_with(series):
        return len({e["tk"] for e in events if e["series"] == series and e["kind"] == "first"})

    print_block("1) First strike-cross in each window, RAW Coinbase spot")
    ev = filter_ev(events, "raw_spot", first_only=True, n_windows=nW)
    print(f"Windows with at least one raw Coinbase cross: {windows_with('raw_spot')} of {nW}")
    report_series("RAW Coinbase spot — first cross (all times)", ev, nW)

    print_block("2) First strike-cross, GAP-CORRECTED Coinbase (walk-forward mean gap added)")
    evc = filter_ev(events, "corr_spot", first_only=True, n_windows=nW)
    print(f"Windows with at least one gap-corrected cross: {windows_with('corr_spot')} of {nW}")
    report_series("GAP-CORRECTED spot — first cross (all times)", evc, nW)

    print_block("3) Robustness of the $4–5 offset (first cross, settlement only + hold P&L)")
    fc = false_cross_counts(events, "raw_spot", "corr_spot", first_only=True)
    print("  First-cross agreement, raw vs walk-forward gap-corrected:")
    print(f"    both crossed, same side: {fc['both_same_side']} (settled that side {fc['both_same_won']})")
    print(f"    both crossed, OPPOSITE sides: {fc['both_opposite_side']}")
    print(f"    raw crossed, corrected never did: {fc['raw_only']} (raw side settled {fc['raw_only_won']})  ← likely false crosses from the ${g['mean']:.2f} offset")
    print(f"    corrected crossed, raw never did: {fc['corr_only']} (corrected side settled {fc['corr_only_won']})")
    print(f"    neither series crossed: {nW - fc['windows_with_any'] + fc['neither']}  (windows tallied {nW})")
    for name, label in (("spot_plus_4", "fixed +$4"), ("spot_plus_4.7", "fixed +$4.70"), ("spot_plus_5", "fixed +$5"),
                        ("raw_avg5", "raw 5s average"), ("corr_avg5", "gap-corrected 5s average")):
        evx = filter_ev(events, name, first_only=True, n_windows=nW)
        st, ho = settle_stats(evx), hold_stats(evx)
        wr = "n/a" if not st["n"] else f"{100*st['win_rate']:.1f}%"
        print(f"  {label}: settle {st['wins']}/{st['n']} = {wr}; hold after fees: {fmt_trade(ho)}")

    print_block("4) “Surprise” first crosses — Kalshi mid was NOT yet on that side of 50¢")
    print("  These are the only crosses where a faster feed could have had a lead.")
    evs_r = filter_ev(events, "raw_spot", first_only=True, surprise=True, n_windows=nW)
    evs_c = filter_ev(events, "corr_spot", first_only=True, surprise=True, n_windows=nW)
    report_series("RAW surprise first crosses", evs_r, nW)
    report_series("GAP-CORRECTED surprise first crosses", evs_c, nW)

    print_block("5) Surprise first crosses with at least 60s left (enough time to hold or swing)")
    evs_r60 = filter_ev(events, "raw_spot", first_only=True, surprise=True, min_left=60, n_windows=nW)
    evs_c60 = filter_ev(events, "corr_spot", first_only=True, surprise=True, min_left=60, n_windows=nW)
    report_series("RAW surprise first, ≥60s left", evs_r60, nW)
    report_series("GAP-CORRECTED surprise first, ≥60s left", evs_c60, nW)

    print_block("6) All crosses (including whipsaws), gap-corrected surprise, ≥60s left")
    ev_all = [e for e in events if e["series"] == "corr_spot" and e["already50"] is False and e["left"] >= 60]
    report_series("GAP-CORRECTED every surprise cross, ≥60s left", ev_all, nW)

    # Archive settlement-only
    if arch:
        print_block("7) Archive windows — settlement hit rate only (Kalshi quotes were stale, no P&L)")
        # seed gap with live's overall mean as a prior only after printing raw; use archive's own walk-forward
        arecs, agaps = archive_settle_only(arch, [])
        print(f"  Archive close gap (official BRTI − Coinbase 60s avg): {mean_sd(agaps)}")
        for name, label in (("raw_spot", "raw Coinbase first cross"), ("corr_spot", "gap-corrected first cross")):
            evx = [e for e in arecs if e["series"] == name and e["kind"] == "first"]
            st = settle_stats(evx)
            wr = "n/a" if not st["n"] else f"{100*st['win_rate']:.1f}%"
            print(f"  {label}: settle {st['wins']}/{st['n']} = {wr}")
            # halves
            mid = len(arch) // 2
            for half, pred in (("1st half", lambda e: e["win_i"] < mid), ("2nd half", lambda e: e["win_i"] >= mid)):
                evh = [e for e in evx if pred(e)]
                sh = settle_stats(evh)
                wrh = "n/a" if not sh["n"] else f"{100*sh['win_rate']:.1f}%"
                print(f"    {half}: {sh['wins']}/{sh['n']} = {wrh}")

    # Save a compact JSON of the key tables
    def pack(evs, swings=True):
        d = {"settle": settle_stats(evs), "hold": hold_stats(evs), "lead": lead_stats(evs),
             "hold_h1": hold_stats([e for e in evs if e["win_i"] < nW // 2]),
             "hold_h2": hold_stats([e for e in evs if e["win_i"] >= nW // 2]),
             "buckets": {name: {"settle": settle_stats([e for e in evs if e["bucket"] == name]),
                                "hold": hold_stats([e for e in evs if e["bucket"] == name]),
                                "lead": lead_stats([e for e in evs if e["bucket"] == name])}
                         for *_, name in BUCKETS}}
        if swings:
            keys = [f"time_{n}s" for n in (3, 5, 10, 20, 30)] + [f"mid_{x}c" for x in (5, 10, 15)] + ["mid_cross_50"]
            d["swings"] = {k: {"all": swing_stats(evs, k),
                               "h1": swing_stats([e for e in evs if e["win_i"] < nW // 2], k),
                               "h2": swing_stats([e for e in evs if e["win_i"] >= nW // 2], k)} for k in keys}
        return d

    payload = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "live_windows": nW,
        "archive_windows": len(arch),
        "gap_close": g,
        "false_cross_raw_vs_corr": fc,
        "raw_first": pack(filter_ev(events, "raw_spot", True, n_windows=nW)),
        "corr_first": pack(filter_ev(events, "corr_spot", True, n_windows=nW)),
        "raw_surprise_first": pack(evs_r),
        "corr_surprise_first": pack(evs_c),
        "raw_surprise_first_60s": pack(evs_r60),
        "corr_surprise_first_60s": pack(evs_c60),
        "corr_surprise_every_60s": pack(ev_all),
        "notes": [
            "Live ticks only for P&L and lead time; archive Kalshi books were stale (~28s list prices).",
            "Logs are Coinbase-only, not the live multi-exchange v48 BRTI approximation.",
            "Gap correction is walk-forward (mean of earlier windows' official-BRTI minus Coinbase 60s close average).",
            "Fills are one tick late (~1.06s) at that tick's ask (entry) or bid (swing exit). Taker fees on every leg.",
            "First cross = first time that series crosses the strike in a given direction in the window.",
            "Surprise = Kalshi YES mid was not yet on the crossed side of 50¢.",
        ],
    }
    OUT.write_text(json.dumps(payload, indent=1, default=lambda o: None))
    print(f"\nSaved {OUT}")

if __name__ == "__main__":
    main()
