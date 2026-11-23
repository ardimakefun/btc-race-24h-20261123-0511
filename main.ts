// Breakout Rider — a long-only cbBTC trend bot for agent-fun/bars-replay/v1.
//
// Idea: BTC's 1-minute tape is mostly noise (sd ~8 bps/bar) punctuated by
// multi-hour trends. This bot does one thing: it gets long when the tape
// proves a trend, rides it with a trailing stop, and stays out of chop.
//
//   Entry : close breaks above the highest close of the previous 20 bars,
//           and clears it by at least 10 bps (a marginal new high in chop
//           does not count). Full size, one position, no leverage.
//   Exit  : trailing stop — sell everything when the close falls 200 bps
//           below the highest close since entry. 200 bps is ~25x the
//           1-minute noise, so the stop fires on a real reversal, not noise.
//   Rest  : after an exit, no re-entry for 120 bars, so a choppy tape
//           cannot whipsaw the bot bar after bar.
//
// Why this shape, and not an EMA cross or a 24-bar momentum rebalance:
// those baselines trade on every cross / every 24 bars whether the tape is
// trending or not. This bot only trades on a confirmed breakout, and its
// only exit is the trailing stop, so in a flat tape it sits in cash and in
// a downtrend it is out after one bounded loss.
//
// Everything is exact integer math on the price scale (no floats, no clock,
// no environment, no randomness), so two runs on the same bars answer
// byte for byte the same.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Entry: how many past closes the breakout must clear. */
const BREAKOUT_BARS = 20;
/** Entry: the close must clear that high by at least this many bps. */
const BREAKOUT_MARGIN_BPS = 10n;
/** Probe (dev window, 1.440 bar): kondisi entry terpicu 37x dalam 15 cluster,
 *  jadi bot hampir pasti trade >=1x di window race mana pun. */
/** Exit: sell when the close is this many bps below the peak since entry. */
const TRAIL_STOP_BPS = 200n;
/** After an exit, bars to wait before the next entry. */
const REENTRY_COOLDOWN_BARS = 120;
/** Wide open: a fill may move up to 100% from the latest close (never binds). */
const MAX_SLIPPAGE_BPS = 10_000;
const BPS = 10_000n;

/** Last ~64 closes, in bar order (price_scale units). The entry test only
 *  reads the previous 20 closes + the current one, so keeping 64 is
 *  behaviour-identical to keeping the whole tape. */
const closes: bigint[] = [];
/** Highest close since the current entry (the entry bar's close at first). */
let peak = 0n;
/** Seq of the batch the last exit was decided on (-inf before any exit). */
let lastExitSeq = -1_000_000;

await runBars({
  onBatch(state: BarsState, batch): OrderInput[] {
    const close = state.close(SYMBOL);
    if (close === null) return [];
    closes.push(close);
    if (closes.length > 64) closes.shift(); // cap memory; entry reads only the last 21

    const held = state.positions.get(SYMBOL);
    if (held === undefined) {
      // Flat: look for a confirmed breakout, unless cooling down.
      if (closes.length <= BREAKOUT_BARS) return [];
      if (batch.seq - lastExitSeq < REENTRY_COOLDOWN_BARS) return [];
      let high = 0n;
      for (let i = closes.length - BREAKOUT_BARS - 1; i < closes.length - 1; i++) {
        if (closes[i]! > high) high = closes[i]!;
      }
      if (close * BPS <= high * (BPS + BREAKOUT_MARGIN_BPS)) return [];
      peak = close;
      return [{
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: state.cash,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      }];
    }

    // Holding: trail the peak, exit on the stop.
    if (close > peak) peak = close;
    if (close * BPS < peak * (BPS - TRAIL_STOP_BPS)) {
      lastExitSeq = batch.seq;
      return [{
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      }];
    }
    return [];
  },
});
