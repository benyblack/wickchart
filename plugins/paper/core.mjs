/**
 * wickchart-paper — pure paper-trading engine: queued market orders fill at
 * the next bar's open, working limits fill intrabar (gap-aware), signed-qty
 * positions net and flip, fees come off cash, and every bar appends a
 * mark-to-market equity point with peak/drawdown tracking. Plain data in /
 * plain data out — no DOM, no canvas, no chart dependency (see tests/).
 *
 * Bar semantics (the honesty contract of the whole plugin):
 *   - an order placed while paused at bar N fills during bar N+1 — you can
 *     never trade a close you have already seen;
 *   - a market fill happens at the next bar's open;
 *   - a limit fill happens at the limit price, or at the open when the open
 *     gaps through it (the better price for the taker, never worse);
 *   - equity is marked at each bar's close: cash + qty × close.
 */

let SEQ = 0;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Fill price for a working limit: the limit, unless the open gaps through
 *  it — then the open (which is strictly better for the taker). */
function limitFill(limit, open, side) {
  return side > 0 ? Math.min(limit, open) : Math.max(limit, open);
}

/**
 * The trading engine. Drive it with {@link PaperModel#onBar} once per bar,
 * in order; everything else is order entry.
 */
export class PaperModel {
  /**
   * @param {{cash?: number, fee?: number, time?: number}} [opts]
   *   `fee` is a fraction of fill notional per fill (0.0004 = 4 bps).
   */
  constructor(opts = {}) {
    this.startCash = isNum(opts.cash) && opts.cash > 0 ? opts.cash : 10000;
    this.fee = isNum(opts.fee) && opts.fee >= 0 && opts.fee <= 0.1 ? opts.fee : 0;
    this._seedTime = isNum(opts.time) ? opts.time : null;
    this.reset();
  }

  /** Reset to the starting account. `time` seeds the first equity point. */
  reset(time) {
    this.cash = this.startCash;
    this.realized = 0;
    this.pos = null; // { qty (signed), entry (average) }
    this.orders = []; // { id, side (+1 buy | -1 sell), type, qty, price?, at }
    this.fills = []; // { id, time, side, qty, price, fee }
    this.closed = []; // { side, qty, entry, exit, pnl, fee, at }
    this.series = []; // { time, equity } — one point per bar, marked at close
    this.peak = this.startCash;
    this.maxDD = 0;
    const t = isNum(time) ? time : this._seedTime;
    if (t != null) this.series.push({ time: t, equity: this.startCash });
    return this;
  }

  /* ---------------- order entry ---------------- */

  _order(side, type, qty, price) {
    const q = Math.max(0, Number(qty) || 0);
    if (!q) return null;
    const o = { id: 'o' + ++SEQ, side, type, qty: q, at: this._lastTime(), price: isNum(price) ? price : undefined };
    this.orders.push(o);
    return o;
  }

  /** Queue a market buy (fills at the next bar's open). */
  buy(qty = 1) {
    return this._order(1, 'market', qty);
  }

  /** Queue a market sell (closes/reduces/flips a long, opens a short). */
  sell(qty = 1) {
    return this._order(-1, 'market', qty);
  }

  /** Working buy limit (fills when a bar trades at or below `price`). */
  buyLimit(price, qty = 1) {
    return isNum(price) && price > 0 ? this._order(1, 'limit', qty, price) : null;
  }

  /** Working sell limit (fills when a bar trades at or above `price`). */
  sellLimit(price, qty = 1) {
    return isNum(price) && price > 0 ? this._order(-1, 'limit', qty, price) : null;
  }

  /** Cancel a working order. True if it was live. */
  cancel(id) {
    const at = this.orders.findIndex((o) => o.id === id);
    if (at < 0) return false;
    this.orders.splice(at, 1);
    return true;
  }

  /** Queue a market order that exactly closes the current position. */
  flatten() {
    return this.pos ? this._order(this.pos.qty > 0 ? -1 : 1, 'market', Math.abs(this.pos.qty)) : null;
  }

  /* ---------------- the bar loop ---------------- */

  /**
   * Advance one bar: queued markets fill at the open (in placement order),
   * then working limits fill intrabar. Returns the fills that happened.
   * @param {{time:number, open:number, high:number, low:number, close:number}} bar
   * @returns {Array<object>}
   */
  onBar(bar) {
    if (!bar || !isNum(bar.open) || !isNum(bar.close)) return [];
    const t = isNum(bar.time) ? bar.time : this._lastTime();
    const out = [];
    // 1) queued markets, at the open, in order
    const rest = [];
    for (const o of this.orders) {
      if (o.type === 'market') out.push(this._fill(o, bar.open, t));
      else rest.push(o);
    }
    // 2) working limits, intrabar (gap-aware price above)
    this.orders = rest.filter((o) => {
      const touched =
        o.side > 0 ? bar.low <= o.price : bar.high >= o.price;
      if (touched) {
        out.push(this._fill(o, limitFill(o.price, bar.open, o.side), t));
        return false;
      }
      return true;
    });
    // 3) mark to market at the close
    const equity = this.equity(bar.close);
    this.series.push({ time: t, equity });
    if (equity > this.peak) this.peak = equity;
    const dd = this.peak > 0 ? (this.peak - equity) / this.peak : 0;
    if (dd > this.maxDD) this.maxDD = dd;
    return out;
  }

  /** Apply one fill: portfolio accounting — cash moves by the notional,
   *  position nets and flips, closing trades are logged with their P&L. */
  _fill(o, price, t) {
    const notional = o.qty * price;
    this.cash += -o.side * notional; // buy pays, sell receives
    const feeCost = notional * this.fee;
    this.cash -= feeCost;
    const f = { id: o.id, time: t, side: o.side, qty: o.qty, price, fee: feeCost };
    this.fills.push(f);

    if (this.pos && this.pos.qty !== 0 && Math.sign(this.pos.qty) === o.side) {
      // adding to the position — average the entry
      const q0 = Math.abs(this.pos.qty);
      this.pos.entry = (this.pos.entry * q0 + price * o.qty) / (q0 + o.qty);
      this.pos.qty += o.side * o.qty;
    } else {
      // opening, reducing, or flipping
      const closingQty = this.pos ? Math.min(Math.abs(this.pos.qty), o.qty) : 0;
      if (this.pos && closingQty > 0) {
        const dir = Math.sign(this.pos.qty);
        // a flip's fee splits proportionally between the close and the flip
        const feeClose = feeCost * (closingQty / o.qty);
        const pnl = (price - this.pos.entry) * closingQty * dir - feeClose;
        this.realized += pnl;
        this.closed.push({
          side: dir, qty: closingQty, entry: this.pos.entry, exit: price,
          pnl, fee: feeClose, at: t,
        });
      }
      const flipQty = o.qty - closingQty;
      if (flipQty > 0) this.pos = { qty: o.side * flipQty, entry: price };
      else {
        this.pos.qty += o.side * o.qty;
        if (this.pos.qty === 0) this.pos = null;
      }
    }
    return f;
  }

  /* ---------------- reads ---------------- */

  /** Mark-to-market account value at `price` (cash + position). */
  equity(price) {
    return this.cash + (this.pos ? this.pos.qty * price : 0);
  }

  /** Unrealized P&L of the open position at `price`. */
  unrealized(price) {
    return this.pos ? (price - this.pos.entry) * this.pos.qty : 0;
  }

  /** Session statistics for readouts and the equity strip. */
  stats() {
    const wins = this.closed.filter((t) => t.pnl > 0).length;
    return {
      cash: this.cash,
      startCash: this.startCash,
      position: this.pos ? { ...this.pos } : null,
      orders: this.orders.map((o) => ({ ...o })),
      realized: this.realized,
      maxDD: this.maxDD,
      trades: this.closed.length,
      wins,
      losses: this.closed.length - wins,
      winRate: this.closed.length ? wins / this.closed.length : null,
    };
  }

  _lastTime() {
    return this.series.length ? this.series[this.series.length - 1].time : 0;
  }
}
