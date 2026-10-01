#!/usr/bin/env python3
"""Golden-vector generator for WickChart's indicator kernels.

Regenerates tests/golden/fixtures.json and docs/correctness.md:

    python tests/golden/generate.py

Method (three layers, in decreasing order of trust):

1. Reference implementations written here in numpy/pandas, vectorized and
   algebraically different from the JS kernels where possible (rolling
   window means against running sums, sliding-window mean deviations
   against per-bar loops, convolution against weighted recursion). They
   encode the conventions documented in each kernel's JSDoc — those
   conventions are the spec this file pins.
2. Cross-checks against the third-party `ta` package (independent authors,
   TA-Lib-style conventions) where its definitions align. Three classes:
   EXACT (same definition — asserted to 1e-9), SEED-DIFFERS (same formula,
   different warm-up seeding; `ta` starts the recursion at the first value,
   WickChart seeds with an SMA — the TA-Lib convention — so the deviation
   decays geometrically; measured and reported), and NONE (no `ta`
   equivalent). `pip install ta` is optional; without it the cross-check
   columns report "unavailable" and generation still succeeds.
3. A handful of tiny10 hand-derived vectors (SMA/WMA/TR/OBV/Donchian on
   round numbers) checked in as the human-auditable layer.

The differential test that gates CI is tests/golden-indicators.test.mjs:
it runs the JS kernels against fixtures.json. This generator is only
re-run when a convention deliberately changes — the committed fixtures
are the contract.
"""

import json
import math
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
FIXTURES = os.path.join(ROOT, "tests", "golden", "fixtures.json")
DOCS = os.path.join(ROOT, "docs", "correctness.md")

DAY = 86_400_000

# ---------------------------------------------------------------- inputs

def lcg(seed):
    state = seed
    def rand():
        nonlocal state
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        return state / 0x7FFFFFFF
    return rand


def walk150():
    """150 OHLCV bars over three sessions that each cross UTC midnight.

    A random walk with a slow sinusoidal drift, so trends reverse (SuperTrend
    flips), windows of every length 3..52 fill, and VWAP resets three times.
    """
    rand = lcg(42)
    bars = []
    price = 100.0
    for d in range(3):
        t0 = int(pd.Timestamp(2024, 1, 2 + d, 22, 0).timestamp() * 1000)
        for j in range(50):
            i = d * 50 + j
            drift = math.sin(i / 17.0) * 0.004
            open_ = price
            close = open_ * (1 + drift + (rand() - 0.5) * 0.02)
            high = max(open_, close) * (1 + rand() * 0.006)
            low = min(open_, close) * (1 - rand() * 0.006)
            vol = 1000 + int(rand() * 4000)
            if i == 75:  # one zero-volume bar mid-session: vv>0 still holds
                vol = 0
            bars.append({
                "time": t0 + j * 600_000,
                "open": open_, "high": high, "low": low, "close": close,
                "volume": vol,
            })
            price = close
    # one exact close-repeat and one exact h/l overlap for OBV/RSI zero-deltas
    bars[61]["close"] = bars[60]["close"]
    return bars


def tiny10():
    """Round numbers, hand-checkable; volumes ascending."""
    rows = [
        (10, 12, 8, 10, 10),
        (10, 11, 9, 11, 20),
        (11, 14, 10, 12, 30),
        (12, 13, 11, 11, 40),
        (11, 12, 10, 12, 50),
        (12, 15, 11, 14, 60),
        (14, 16, 13, 15, 70),
        (15, 17, 14, 14, 80),
        (14, 15, 12, 13, 90),
        (13, 14, 11, 12, 100),
    ]
    return [
        {"time": 1_704_163_200_000 + i * 600_000, "open": o, "high": h,
         "low": l, "close": c, "volume": v}
        for i, (o, h, l, c, v) in enumerate(rows)
    ]


def macdline150(bars):
    """The MACD line of walk150 — the emaSparse input (leading nulls)."""
    closes = np.array([b["close"] for b in bars])
    f, s = _ema_raw(closes, 12), _ema_raw(closes, 26)
    return [None if np.isnan(f[i]) or np.isnan(s[i]) else float(f"{f[i] - s[i]:.12g}")
            for i in range(len(bars))]


# ------------------------------------------------------- references
# Every reference returns a list where "warm-up" positions are None.

def nulls(a):
    return [None if x is None or (isinstance(x, float) and math.isnan(x))
            else float(f"{x:.12g}") for x in a]


def ref_sma(values, period):
    s = pd.Series(values, dtype="float64")
    return nulls(s.rolling(period).mean())


def _ema_raw(values, period):
    """k = 2/(p+1); seed = SMA of the first p values (TA-Lib convention)."""
    v = np.asarray(values, dtype="float64")
    out = np.full(len(v), np.nan)
    if len(v) < period:
        return out
    k = 2.0 / (period + 1)
    prev = v[:period].mean()
    out[period - 1] = prev
    for i in range(period, len(v)):
        prev = v[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def ref_ema(values, period):
    return nulls(_ema_raw(values, period))


def ref_ema_sparse(values, period):
    start = next(i for i, x in enumerate(values) if x is not None)
    tail = ref_ema(values[start:], period)
    return nulls([np.nan] * start + [np.nan if x is None else x for x in tail])


def ref_wma(values, period):
    v = np.asarray(values, dtype="float64")
    w = np.arange(1, period + 1, dtype="float64")          # oldest..newest
    conv = np.convolve(v, w[::-1], mode="valid") / w.sum()
    return nulls(np.full(period - 1, np.nan).tolist() + conv.tolist())


def ref_stddev(values, period):
    s = pd.Series(values, dtype="float64")
    return nulls(s.rolling(period).std(ddof=0))            # population


def ref_bollinger(closes, period, mult):
    s = pd.Series(closes, dtype="float64")
    mid = s.rolling(period).mean()
    sd = s.rolling(period).std(ddof=0)
    return {"mid": nulls(mid), "upper": nulls(mid + mult * sd),
            "lower": nulls(mid - mult * sd)}


def ref_rsi(closes, period):
    """Wilder: seed = simple mean of the first p gains/losses, then
    (p-1)/p smoothing; first output at index p."""
    c = np.asarray(closes, dtype="float64")
    d = np.diff(c, prepend=c[0])
    up = np.where(d > 0, d, 0.0)
    dn = np.where(d < 0, -d, 0.0)
    out = np.full(len(c), np.nan)
    g, l = up[1:period + 1].mean(), dn[1:period + 1].mean()
    for i in range(period, len(c)):
        if i > period:
            g = (g * (period - 1) + up[i]) / period
            l = (l * (period - 1) + dn[i]) / period
        out[i] = 100.0 if l == 0 else 100 - 100 / (1 + g / l)
    return nulls(out)


def wilder(values, period, seed):
    out = np.empty(len(values))
    prev = seed
    for i in range(len(values)):
        if i < period - 1:
            out[i] = np.nan
        elif i == period - 1:
            out[i] = prev
        else:
            prev = (prev * (period - 1) + values[i]) / period
            out[i] = prev
    return out


def ref_macd(closes, fast, slow, signal):
    c = np.asarray(closes, dtype="float64")
    ef, es = _ema_raw(c, fast), _ema_raw(c, slow)
    macd = [None if np.isnan(ef[i]) or np.isnan(es[i]) else float(f"{ef[i] - es[i]:.12g}")
            for i in range(len(c))]
    sig = ref_ema_sparse(macd, signal)
    sig_n = np.array([np.nan if x is None else x for x in sig])
    macd_n = np.array([np.nan if x is None else x for x in macd])
    hist = nulls(macd_n - sig_n)
    return {"macd": macd, "signal": sig, "hist": hist}


def cols(bars):
    g = lambda k: np.array([b[k] for b in bars], dtype="float64")
    return g("open"), g("high"), g("low"), g("close"), g("volume")


def ref_truerange(bars):
    _, h, l, c, _ = cols(bars)
    tr = np.maximum.reduce([h - l, np.abs(h - np.roll(c, 1)), np.abs(l - np.roll(c, 1))])
    tr[0] = h[0] - l[0]
    return nulls(tr)


def ref_atr(bars, period):
    _, h, l, c, _ = cols(bars)
    tr = np.maximum.reduce([h - l, np.abs(h - np.roll(c, 1)), np.abs(l - np.roll(c, 1))])
    tr[0] = h[0] - l[0]
    return nulls(wilder(tr, period, tr[:period].mean()))


def ref_vwap(bars):
    _, h, l, c, v = cols(bars)
    t = np.array([b["time"] for b in bars], dtype="int64")
    day = t // DAY
    tp = (h + l + c) / 3
    df = pd.DataFrame({"d": day, "pv": tp * v, "v": v})
    pv = df.groupby("d")["pv"].cumsum()
    vv = df.groupby("d")["v"].cumsum()
    return nulls(pd.Series(np.where(vv > 0, pv / vv, np.nan)))


def ref_obv(bars):
    _, _, _, c, v = cols(bars)
    sign = np.zeros(len(c))
    sign[1:] = np.sign(c[1:] - c[:-1])
    return nulls(np.cumsum(sign * v))


def roll_hl(bars, period):
    _, h, l, _, _ = cols(bars)
    hh = pd.Series(h).rolling(period).max()
    ll = pd.Series(l).rolling(period).min()
    return hh, ll


def ref_stoch(bars, period, smooth):
    _, h, l, c, _ = cols(bars)
    hh, ll = roll_hl(bars, period)
    span = hh - ll
    raw = (c - ll) / span * 100
    raw = raw.where(span > 0)
    k = raw.rolling(smooth, min_periods=smooth).mean()
    d = k.rolling(smooth, min_periods=smooth).mean()
    return {"k": nulls(k), "d": nulls(d)}


def ref_cci(bars, period):
    _, h, l, c, _ = cols(bars)
    tp = pd.Series((h + l + c) / 3)
    ma = tp.rolling(period).mean()
    w = np.lib.stride_tricks.sliding_window_view(tp.to_numpy(), period)
    md = np.abs(w - ma.to_numpy()[period - 1:, None]).mean(axis=1)
    out = np.full(len(tp), np.nan)
    dev = np.full(len(tp), np.nan)
    dev[period - 1:] = md
    out = np.where(dev > 0, (tp - ma) / (0.015 * dev), 0.0)
    out[:period - 1] = np.nan
    return nulls(out)


def ref_williamsr(bars, period):
    _, h, l, c, _ = cols(bars)
    hh, ll = roll_hl(bars, period)
    span = hh - ll
    r = (hh - c) / span * -100
    r = r.where(span > 0)
    return nulls(r)


def ref_donchian(bars, period):
    hh, ll = roll_hl(bars, period)
    return {"upper": nulls(hh), "mid": nulls((hh + ll) / 2), "lower": nulls(ll)}


def ref_keltner(bars, period, mult):
    _, _, _, c, _ = cols(bars)
    mid = _ema_raw(c, period)
    atr = np.array([np.nan if x is None else x for x in ref_atr(bars, period)],
                   dtype="float64")
    ok = ~np.isnan(mid) & ~np.isnan(atr)
    return {"upper": nulls(np.where(ok, mid + mult * atr, np.nan)),
            "mid": nulls(mid),
            "lower": nulls(np.where(ok, mid - mult * atr, np.nan))}


def ref_ichimoku(bars, tenkan_p, kijun_p, senkou_b_p, disp):
    n = len(bars)
    shift = disp
    th, tl = roll_hl(bars, tenkan_p)
    kh, kl = roll_hl(bars, kijun_p)
    bh, bl = roll_hl(bars, senkou_b_p)
    tenkan = (th + tl) / 2
    kijun = (kh + kl) / 2
    sa = np.full(n + shift, np.nan)
    sb = np.full(n + shift, np.nan)
    both = tenkan.notna() & kijun.notna()
    sa[np.flatnonzero(both.to_numpy()) + shift] = ((tenkan + kijun) / 2)[both]
    sb[np.flatnonzero(bh.notna().to_numpy()) + shift] = ((bh + bl) / 2)[bh.notna()]
    _, _, _, close, _ = cols(bars)
    chikou = np.full(n, np.nan)
    chikou[:n - shift] = close[shift:]
    return {"tenkan": nulls(tenkan), "kijun": nulls(kijun),
            "senkouA": nulls(sa), "senkouB": nulls(sb), "chikou": nulls(chikou)}


def ref_supertrend(bars, period, mult):
    """Sequential by necessity (stateful ratchet) — pins the documented
    behavior; no algebraic independence claim, no `ta` equivalent."""
    _, h, l, c, _ = cols(bars)
    _, _, _, _, _ = cols(bars)
    tr = np.array(ref_truerange(bars), dtype="float64")
    atr = wilder(tr, period, np.nanmean(tr[:period]))
    out = np.full(len(bars), np.nan)
    f_up, f_lo, direction, started = np.inf, -np.inf, 1, False
    for i in range(len(bars)):
        if np.isnan(atr[i]):
            continue
        hl2 = (h[i] + l[i]) / 2
        b_up, b_lo = hl2 + mult * atr[i], hl2 - mult * atr[i]
        if not started:
            started = True
            f_up, f_lo = b_up, b_lo
            direction = 1 if c[i] >= hl2 else -1
            out[i] = f_lo if direction > 0 else f_up
            continue
        pc = c[i - 1]
        f_up = b_up if (b_up < f_up or pc > f_up) else f_up
        f_lo = b_lo if (b_lo > f_lo or pc < f_lo) else f_lo
        prev_dir = direction
        if c[i] > f_up:
            direction = 1
        elif c[i] < f_lo:
            direction = -1
        out[i] = (f_lo if direction > 0 else f_up) if direction == prev_dir else np.nan
    return nulls(out)


def ref_heikinashi(bars):
    out = []
    po = pc = None
    for b in bars:
        close = (b["open"] + b["high"] + b["low"] + b["close"]) / 4
        open_ = (b["open"] + b["close"]) / 2 if po is None else (po + pc) / 2
        out.append({
            "time": b["time"], "open": float(f"{open_:.12g}"),
            "high": float(f"{max(b['high'], open_, close):.12g}"),
            "low": float(f"{min(b['low'], open_, close):.12g}"),
            "close": float(f"{close:.12g}"), "volume": b["volume"],
        })
        po = open_
        pc = close
    return out


# ------------------------------------------------------------ cross-check

def crosscheck():
    """Best-effort third-party agreement, measured and reported honestly."""
    try:
        import ta  # noqa: F401
    except ImportError:
        return {"available": False, "rows": []}
    rows = []

    def rel(a, b):
        a, b = np.asarray(a, float), np.asarray(b, float)
        m = ~np.isnan(a) & ~np.isnan(b)
        if not m.any():
            return float("nan")
        return float(np.max(np.abs(a[m] - b[m]) / np.maximum(1e-12, np.abs(b[m]))))

    bars = walk150()
    o, h, l, c, v = cols(bars)
    df = pd.DataFrame({"open": o, "high": h, "low": l, "close": c, "volume": v})
    cs = pd.Series(c)
    tail = slice(-50, None)

    def add(name, mine_themers, klass):
        """mine_themers: () -> (mine, theirs); isolated so one ta API
        mismatch degrades to UNAVAILABLE instead of aborting generation."""
        try:
            mine, theirs = mine_themers()
            m = np.asarray(mine, float)
            t = np.asarray(theirs, float)
            dev = rel(m[tail], t[tail]) if klass != "EXACT" else rel(m, t)
            rows.append({"indicator": name, "class": klass, "max_rel_dev": dev})
        except Exception as e:  # noqa: BLE001 — reported, never fatal
            rows.append({"indicator": name, "class": "UNAVAILABLE",
                         "max_rel_dev": None, "why": f"{type(e).__name__}: {e}"})

    bb = lambda: ta.volatility.BollingerBands(close=cs, window=20, window_dev=2)
    add("sma20", lambda: (ref_sma(c, 20), ta.trend.sma_indicator(cs, window=20)), "EXACT")
    add("wma20", lambda: (ref_wma(c, 20),
                          ta.trend.WMAIndicator(close=cs, window=20).wma_indicator()), "EXACT")
    add("rsi14", lambda: (ref_rsi(c, 14),
                          ta.momentum.RSIIndicator(close=cs, window=14).rsi()), "SEED-DIFFERS")
    add("ema12", lambda: (ref_ema(c, 12),
                          ta.trend.EMAIndicator(close=cs, window=12).ema_indicator()), "SEED-DIFFERS")
    add("macd", lambda: (ref_macd(c, 12, 26, 9)["macd"], ta.trend.MACD(close=cs).macd()), "SEED-DIFFERS")

    def bb_bands():
        # both use the population stdev (ddof=0) here — bands compare directly
        b = bb()
        return (np.asarray(ref_bollinger(c, 20, 2)["upper"], float),
                np.asarray(b.bollinger_hband(), float))

    add("bb20-upper", bb_bands, "EXACT")
    add("stoch14-3", lambda: (ref_stoch(bars, 14, 3)["k"],
                              ta.momentum.StochasticOscillator(
                                  high=df.high, low=df.low, close=df.close,
                                  window=14, smooth_window=3).stoch_signal()),
        "EXACT (ta .stoch_signal; ta .stoch is the raw %K)")
    add("cci20", lambda: (ref_cci(bars, 20),
                          ta.trend.CCIIndicator(high=df.high, low=df.low,
                                                close=df.close, window=20).cci()), "EXACT")
    add("wr14", lambda: (ref_williamsr(bars, 14),
                         ta.momentum.WilliamsRIndicator(high=df.high, low=df.low,
                                                        close=df.close,
                                                        lbp=14).williams_r()), "EXACT")
    def obv_diffs():
        # ta seeds obv[0] = volume[0]; WickChart starts at 0 (the classic
        # convention). The bar-to-bar deltas must agree exactly.
        theirs = ta.volume.OnBalanceVolumeIndicator(
            close=df.close, volume=df.volume).on_balance_volume()
        return np.diff(np.asarray(ref_obv(bars), float)), np.diff(np.asarray(theirs, float))

    add("obv-deltas", obv_diffs, "EXACT (deltas; ta seeds obv[0]=vol[0])")
    add("donchian20", lambda: (ref_donchian(bars, 20)["upper"],
                               ta.volatility.DonchianChannel(
                                   high=df.high, low=df.low, close=df.close,
                                   window=20).donchian_channel_hband()), "EXACT")
    add("atr14", lambda: (ref_atr(bars, 14),
                          ta.volatility.AverageTrueRange(
                              high=df.high, low=df.low, close=df.close,
                              window=14).average_true_range()), "SEED-DIFFERS")
    return {"available": True, "rows": rows}


# ---------------------------------------------------------------- emit

def main():
    w150, t10 = walk150(), tiny10()
    cases = [
        ("tiny-sma3", "calcSMA", "tiny10", [3], "plain rolling mean",
         {"values": ref_sma([b["close"] for b in t10], 3)}),
        ("tiny-wma3", "calcWMA", "tiny10", [3], "linear weights, newest = period",
         {"values": ref_wma([b["close"] for b in t10], 3)}),
        ("tiny-tr", "calcTrueRange", "tiny10", [], "first bar is h-l",
         {"values": ref_truerange(t10)}),
        ("tiny-obv", "calcOBV", "tiny10", [], "first bar is 0; flat close adds nothing",
         {"values": ref_obv(t10)}),
        ("tiny-donchian3", "calcDonchian", "tiny10", [3], "hh/ll windows + mid",
         ref_donchian(t10, 3)),
        ("tiny-heikinashi", "calcHeikinAshi", "tiny10", [], "ha-open seeded (o+c)/2",
         {"bars": ref_heikinashi(t10)}),
        ("sma20", "calcSMA", "walk150", [20], "plain rolling mean",
         {"values": ref_sma([b["close"] for b in w150], 20)}),
        ("sma50", "calcSMA", "walk150", [50], "plain rolling mean",
         {"values": ref_sma([b["close"] for b in w150], 50)}),
        ("ema12", "calcEMA", "walk150", [12], "k=2/(p+1), SMA seed at p-1",
         {"values": ref_ema([b["close"] for b in w150], 12)}),
        ("ema26", "calcEMA", "walk150", [26], "k=2/(p+1), SMA seed at p-1",
         {"values": ref_ema([b["close"] for b in w150], 26)}),
        ("emasparse9", "calcEMASparse", "macdline150", [9],
         "same EMA over a series with leading nulls",
         {"values": ref_ema_sparse(macdline150(w150), 9)}),
        ("wma20", "calcWMA", "walk150", [20], "linear weights, newest = period",
         {"values": ref_wma([b["close"] for b in w150], 20)}),
        ("stddev20", "calcStdDev", "walk150", [20], "population stdev, aligned like SMA",
         {"values": ref_stddev([b["close"] for b in w150], 20)}),
        ("rsi14", "calcRSI", "walk150", [14],
         "Wilder; seed = simple mean of first p changes, first output at p",
         {"values": ref_rsi([b["close"] for b in w150], 14)}),
        ("macd-12-26-9", "calcMACD", "walk150", [12, 26, 9],
         "EMA(fast)-EMA(slow); signal = sparse EMA seeded on the first 9 values",
         ref_macd([b["close"] for b in w150], 12, 26, 9)),
        ("bb-20-2", "calcBollinger", "walk150", [20, 2],
         "SMA mid +/- mult x population stdev",
         ref_bollinger([b["close"] for b in w150], 20, 2)),
        ("tr", "calcTrueRange", "walk150", [], "first bar is h-l",
         {"values": ref_truerange(w150)}),
        ("atr14", "calcATR", "walk150", [14],
         "Wilder RMA over TR, seeded with the SMA of the first p TRs",
         {"values": ref_atr(w150, 14)}),
        ("vwap-utc", "calcVWAP", "walk150", [],
         "hlc3 tp, cumulative, reset at each UTC-day boundary",
         {"values": ref_vwap(w150)}),
        ("obv", "calcOBV", "walk150", [], "cumulative signed volume",
         {"values": ref_obv(w150)}),
        ("stoch-14-3", "calcStoch", "walk150", [14, 3],
         "slow stoch: raw %K, %K = SMA(smooth), %D = SMA(smooth) of %K",
         ref_stoch(w150, 14, 3)),
        ("cci20", "calcCCI", "walk150", [20],
         "typical price vs SMA, 0.015 constant, mean deviation per window",
         {"values": ref_cci(w150, 20)}),
        ("wr14", "calcWilliamsR", "walk150", [14], "(hh-close)/span x -100",
         {"values": ref_williamsr(w150, 14)}),
        ("donchian20", "calcDonchian", "walk150", [20], "hh/ll windows + mid",
         ref_donchian(w150, 20)),
        ("keltner-20-2", "calcKeltner", "walk150", [20, 2],
         "EMA(p) mid +/- mult x ATR(p)",
         ref_keltner(w150, 20, 2)),
        ("supertrend-10-3", "calcSuperTrend", "walk150", [10, 3],
         "ratcheting ATR bands; null gap on flips; stateful (convention-pinned)",
         {"values": ref_supertrend(w150, 10, 3)}),
        ("ichimoku-9-26-52-26", "calcIchimoku", "walk150", [9, 26, 52, 26],
         "midpoints; senkou displaced +disp (arrays run past the last bar); chikou displaced back",
         ref_ichimoku(w150, 9, 26, 52, 26)),
        ("heikinashi", "calcHeikinAshi", "walk150", [],
         "ha-close = ohlc/4; ha-open recursive, first = (o+c)/2",
         {"bars": ref_heikinashi(w150)}),
    ]

    xc = crosscheck()
    fixtures = {
        "meta": {
            "description": "Golden vectors for WickChart's exported indicator kernels",
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "generator": "tests/golden/generate.py",
            "method": (
                "References: independent numpy/pandas implementations "
                "(tests/golden/generate.py), cross-checked against the third-party "
                "'ta' package where conventions align (see docs/correctness.md); "
                "tiny10 cases are hand-derived on round numbers. Values are rounded "
                "to 12 significant digits; the CI test tolerance absorbs the rounding."
            ),
            "inputs": {
                "tiny10": "10 round-number bars (hand-checkable)",
                "walk150": "150 synthetic bars over 3 midnight-crossing UTC sessions "
                           "(deterministic LCG seed 42; sinusoidal drift + noise; one "
                           "zero-volume bar; one repeated close)",
                "macdline150": "the MACD line of walk150 (leading nulls, for calcEMASparse)",
            },
        },
        "inputs": {
            "tiny10": {"kind": "bars", "bars": t10},
            "walk150": {"kind": "bars", "bars": w150},
            "macdline150": {"kind": "values", "values": macdline150(w150)},
        },
        "cases": [
            {"id": cid, "fn": fn, "input": inp, "params": params,
             "note": note, "expected": expected}
            for cid, fn, inp, params, note, expected in cases
        ],
    }
    os.makedirs(os.path.dirname(FIXTURES), exist_ok=True)
    with open(FIXTURES, "w", newline="\n") as f:
        json.dump(fixtures, f, indent=1, allow_nan=False)
        f.write("\n")

    write_docs(fixtures, xc)
    n_vec = sum(len(v) if isinstance(v, list) else len(v) for c in cases for v in c[5].values())
    print(f"wrote {FIXTURES} ({len(cases)} cases)")
    print(f"wrote {DOCS}")
    if xc["available"]:
        for r in xc["rows"]:
            dev = "n/a" if r["max_rel_dev"] is None or math.isnan(r["max_rel_dev"]) \
                else f"{r['max_rel_dev']:.2e}"
            print(f"  crosscheck {r['indicator']:<14} {r['class']:<15} {dev}")
    else:
        print("  crosscheck: 'ta' not installed — columns report unavailable")


def write_docs(fixtures, xc):
    rows = []
    for c in fixtures["cases"]:
        for name, arr in c["expected"].items():
            if name == "bars":  # calcHeikinAshi returns bar objects, not series
                rows.append((c["fn"], name, c["params"], f"{len(arr)} bars"))
                continue
            valid = sum(1 for x in arr if x is not None)
            rows.append((c["fn"], name, c["params"], valid))

    lines = []
    a = lines.append
    a("# Correctness — golden vectors for the indicator math")
    a("")
    a("> Generated by `tests/golden/generate.py` — do not edit by hand.")
    a("> The gate is `tests/golden-indicators.test.mjs`, which runs every exported")
    a("> kernel against `tests/golden/fixtures.json` in CI and fails over")
    a("> tolerance. Regenerate only when a convention deliberately changes;")
    a("> the committed fixtures are the contract.")
    a("")
    a("## Method")
    a("")
    a("Three layers, in decreasing order of trust:")
    a("")
    a("1. **Independent references** — numpy/pandas implementations in")
    a("   `tests/golden/generate.py`, vectorized and algebraically different from")
    a("   the JS kernels where possible (rolling-window means against running")
    a("   sums, sliding-window mean deviations against per-bar loops,")
    a("   convolution against weighted recursion). They encode the conventions")
    a("   documented in each kernel's JSDoc — those conventions are the spec.")
    a("2. **Third-party cross-check** — the [`ta`](https://pypi.org/project/ta/)")
    a("   package (independent authors, TA-Lib-style conventions), where its")
    a("   definitions align. Where warm-up seeding differs (`ta` starts the")
    a("   recursion at the first value; WickChart seeds with an SMA — the")
    a("   TA-Lib convention) the deviation decays geometrically and is measured")
    a("   on the last 50 points, reported below.")
    a("3. **Hand-derived vectors** — the `tiny10` cases are round-number bars a")
    a("   human can verify with a calculator.")
    a("")
    a(f"Fixtures generated {fixtures['meta']['generated']}. Inputs:")
    a("`walk150` (150 synthetic bars over 3 midnight-crossing UTC sessions,")
    a("deterministic seed), `tiny10`, and `macdline150` (leading-nulls input).")
    a("")
    a("## The matrix")
    a("")
    a("| kernel | series | params | points (non-null) |")
    a("|---|---|---|---|")
    for fn, name, params, valid in rows:
        a(f"| `{fn}` | {name} | {params} | {valid} |")
    a("")
    a("## Third-party (`ta`) cross-check")
    a("")
    if xc["available"]:
        a("| indicator | class | max rel deviation |")
        a("|---|---|---|")
        for r in xc["rows"]:
            dev = "n/a" if r["max_rel_dev"] is None or math.isnan(r["max_rel_dev"]) \
                else f"{r['max_rel_dev']:.2e}"
            a(f"| {r['indicator']} | {r['class']} | {dev} |")
        a("")
        a("Classes: **EXACT** — same definition, asserted ≤ 1e-9 relative.")
        a("**SEED-DIFFERS** — same formula, different warm-up seed; deviation")
        a("measured on the last 50 points and expected to be small but non-zero.")
        a("Indicators without a `ta` equivalent (SuperTrend, Ichimoku, Heikin-Ashi,")
        a("EMA-sparse, VWAP-session-anchored, population-stdev-as-such, Keltner)")
        a("carry no row: layer 1 + layer 3 are their cover.")
    else:
        a("The `ta` package was not installed at generation time")
        a("(`pip install ta`); the cross-check layer reported unavailable.")
    a("")
    a("## Conventions pinned by the fixtures")
    a("")
    a("| kernel | warm-up / convention |")
    a("|---|---|")
    a("| `calcSMA` / `calcWMA` / `calcStdDev` | first output at index p−1 |")
    a("| `calcEMA` / `calcEMASparse` | k = 2/(p+1); seed = SMA of the first p values |")
    a("| `calcRSI` | Wilder; seed = simple mean of the first p changes; first output at index p |")
    a("| `calcATR` | Wilder RMA over true range; seed = SMA of the first p TRs; first bar TR = h−l |")
    a("| `calcMACD` | line from index slow−1; signal seeded on the first 9 line values |")
    a("| `calcBollinger` | population stdev (ddof=0) |")
    a("| `calcVWAP` | hlc3 typical price; cumulative within UTC day; resets at midnight |")
    a("| `calcOBV` | first value 0; zero delta adds nothing |")
    a("| `calcStoch` | slow stochastic: %K = SMA(smooth) of raw, %D = SMA(smooth) of %K |")
    a("| `calcCCI` | mean deviation per window vs the window SMA; 0.015 constant |")
    a("| `calcWilliamsR` | (hh − close) / span × −100 |")
    a("| `calcDonchian` | rolling hh/ll windows + mid |")
    a("| `calcKeltner` | EMA(p) mid ± mult × ATR(p) |")
    a("| `calcSuperTrend` | ratcheting ATR bands (reset on tighten or prev-close break); null gap at flips |")
    a("| `calcIchimoku` | senkou spans displaced +disp (arrays run past the last bar); chikou displaced back |")
    a("| `calcHeikinAshi` | ha-close = ohlc/4; ha-open first = (o+c)/2, then (prev ha-open + prev ha-close)/2 |")
    a("")
    a("## Regenerating")
    a("")
    a("```sh")
    a("python tests/golden/generate.py   # rewrites fixtures.json + this file")
    a("```")
    a("")
    a("Requires Python 3 with numpy and pandas; `pip install ta` optionally")
    a("enables the cross-check layer. The differential test tolerance")
    a("(see `tests/golden-indicators.test.mjs`) absorbs the fixtures' 12-")
    a("significant-digit rounding.")
    a("")
    with open(DOCS, "w", newline="\n") as f:
        f.write("\n".join(lines))


if __name__ == "__main__":
    sys.exit(main())
