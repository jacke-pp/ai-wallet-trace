// Turning transfers into trades, and an average-cost book. Pure functions, tested offline.
// Stablecoins and WBNB are "money"; anything else is "a coin". In one transaction, for one wallet:
//   money out + one coin in  = buy        one coin out + money in = sell
//   one coin only (in or out) = the other side may be native BNB, which leaves no log: resolved later from the BNB balance
//   one coin out + another in = a coin-for-coin swap (a Flap BNCB-pool trade): a sale of one and a buy of the other
// A coin that arrived for free (airdrop, a transfer from someone) has no known cost, so selling it is not counted as profit.

export const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const MONEY = {
  '0x55d398326f99059ff775485246999027b3197955': 'USDT', '0xce24439f2d9c6a2289f741120fe202248b666666': 'U',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC', '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409': 'FDUSD',
  '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d': 'USD1', [WBNB]: 'WBNB',
};
const E18 = 1e18;
export const usdOf = (tok, amt, bnbUsd) => Number(amt) / E18 * (tok === WBNB ? bnbUsd : 1);

// rows ([b, t, x, li, tok, from, to, amt]) -> Map tx -> { b, t, legs: Map wallet -> { out: Map tok -> BigInt, in: Map } }
export function group(rows, isOwner) {
  const txs = new Map(), seen = new Set();
  for (const [b, t, x, li, tok, from, to, amt] of rows) {
    const key = x + ':' + li; if (seen.has(key)) continue; seen.add(key);   // a transfer between two watched wallets shows up twice
    const v = BigInt(amt); if (v === 0n || from === to) continue;
    if (!txs.has(x)) txs.set(x, { b, t, legs: new Map() });
    const tx = txs.get(x);
    for (const [who, dir] of [[from, 'out'], [to, 'in']]) {
      if (!isOwner(who)) continue;
      if (!tx.legs.has(who)) tx.legs.set(who, { out: new Map(), in: new Map() });
      const m = tx.legs.get(who)[dir]; m.set(tok, (m.get(tok) || 0n) + v);
    }
  }
  return txs;
}

// one wallet's side of one tx -> { k: 'buy'|'sell', tok, q, usd } | { k: 'in?'|'out?', tok, q } | { k: 'swap', tok, q, give, gq } | null
export function classify(g, bnbUsd) {
  const coins = (m) => [...m].filter(([t]) => !MONEY[t]);
  const money = (m) => [...m].filter(([t]) => MONEY[t]).reduce((s, [t, v]) => s + usdOf(t, v, bnbUsd), 0);
  const ci = coins(g.in), co = coins(g.out), mi = money(g.in), mo = money(g.out);
  if (ci.length === 1 && !co.length) return mo > 0 ? { k: 'buy', tok: ci[0][0], q: ci[0][1], usd: Math.max(0, mo - mi) } : { k: 'in?', tok: ci[0][0], q: ci[0][1] };
  if (co.length === 1 && !ci.length) return mi > 0 ? { k: 'sell', tok: co[0][0], q: co[0][1], usd: mi } : { k: 'out?', tok: co[0][0], q: co[0][1] };
  if (ci.length === 1 && co.length === 1) return { k: 'swap', tok: ci[0][0], q: ci[0][1], give: co[0][0], gq: co[0][1] };
  return null;
}

// Average-cost book. Only coins with a known cost can make or lose money.
export function createBook() {
  const pos = new Map();   // tok -> { q: BigInt, cost: number }
  const s = { pnl: 0, cost: 0, buys: 0, sells: 0, volume: 0, wins: 0, closes: 0, byTok: new Map(), trades: [] };
  const tokStat = (tok) => { if (!s.byTok.has(tok)) s.byTok.set(tok, { pnl: 0, cost: 0, closes: 0 }); return s.byTok.get(tok); };
  return {
    stats: s,
    buy(tok, q, usd, t, x, w) {
      const p = pos.get(tok) || { q: 0n, cost: 0 }; p.q += q; p.cost += usd; pos.set(tok, p);
      s.buys++; s.volume += usd; s.trades.push({ k: 'buy', tok, q, usd, t, x, w });
    },
    sell(tok, q, usd, t, x, w) {
      s.sells++; s.volume += usd; const tr = { k: 'sell', tok, q, usd, t, x, w }; s.trades.push(tr);
      const p = pos.get(tok); if (!p || p.q <= 0n) return null;
      const m = q < p.q ? q : p.q;   // only the part we know the cost of
      const share = Number(m) / Number(p.q), costOut = p.cost * share, gain = usd * (Number(m) / Number(q)) - costOut;
      p.q -= m; p.cost -= costOut;
      s.pnl += gain; s.cost += costOut; const ts = tokStat(tok); ts.pnl += gain; ts.cost += costOut; ts.closes++;
      s.closes++; if (gain > 0) s.wins++;
      tr.gain = gain; tr.cost = costOut;
      return gain;
    },
    moveOut(tok, q) {   // sent away: the cost leaves with it, nothing realized
      const p = pos.get(tok); if (!p || p.q <= 0n) return;
      const m = q < p.q ? q : p.q; p.cost -= p.cost * Number(m) / Number(p.q); p.q -= m;
    },
    holds: (tok) => (pos.get(tok)?.q || 0n) > 0n,
    open: () => [...pos].filter(([, p]) => p.q > 0n).map(([tok, p]) => ({ tok, q: p.q, cost: p.cost })),
  };
}

// Quantity-weighted median price of the priced trades within 2 hours of t; null with fewer than 2.
// (Dust trades, like a liquidity add booked as a buy, carry almost no quantity and can't move it.)
export function medianPrice(points, t) {
  const v = points.filter((p) => Math.abs(p[0] - t) <= 7200);
  if (v.length < 2) return null;
  v.sort((a, b) => a[1] - b[1]);
  const total = v.reduce((s, p) => s + p[2], 0); let acc = 0;
  for (const p of v) { acc += p[2]; if (acc >= total / 2) return p[1]; }
  return null;
}
