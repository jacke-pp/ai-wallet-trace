// 扒链: which other wallets belong to the person behind a .ai wallet, and what never counts as theirs.
// A .ai (Agent ID) wallet is usually a side wallet: BNB or USDT comes in from the person's main wallet or an exchange
// withdrawal, and profits and coins go back to be sold there. A wallet is tied to the .ai wallet when (any one is enough):
//   - it paid the .ai wallet its first BNB
//   - real stablecoin/WBNB moved between them, $20+ either way
//   - the .ai wallet sent it 2+ transfers of coins the .ai wallet really bought (address-poisoning spam uses fake coins
//     the wallet never bought, so it can't tie anyone)
// Never tied: contracts (EIP-7702 smart wallets, code 0xef0100…, are people and do count), exchanges and other very busy
// addresses, burn addresses, bots (more than BOT_LEGS trades), and any wallet tied to more than SERVICE .ai wallets
// (a faucet, OTC desk or bot, not one person).
import fs from 'node:fs';
import path from 'node:path';

export const SERVICE = 6, MIN_USD = 20, MIN_COINS = 2, BUSY_NONCE = 20_000, BOT_LEGS = 5000;
const BURN = /^0x0{36}(0000|dead)$/;
// Well-known Binance exchange wallets on BSC; any other very busy address is "an exchange or service".
export const EXCHANGES = new Set([
  '0x8894e0a0c962cb723c1976a4421c95949be2d4e3', '0xf977814e90da44bfa03b6295a0616a897441acec', '0x5a52e96bacdabb82fd05763e25335261b270efcb',
  '0xe2fc31f816a9b94326492132018c3aecc4a93ae1', '0x3c783c21a0383057d128bae431894a5c19f9cf06', '0xdccf3b77da55107280bd850ea519df3705d1a75a',
]);

export const strong = (e) => e.first || e.moneyIn >= MIN_USD || e.moneyOut >= MIN_USD || e.coinsOut >= MIN_COINS;

// evidence: Map ai -> Map other -> { first, moneyIn, moneyOut, coinsOut };  kindOf(a) -> 'wallet'|'7702'|'contract'|'exchange'|'bot'
// Returns Map ai -> Set of tied wallets.
export function ties(evidence, kindOf) {
  const count = new Map();
  for (const m of evidence.values()) for (const [a, e] of m) if (strong(e)) count.set(a, (count.get(a) || 0) + 1);
  const out = new Map();
  for (const [o, m] of evidence) {
    const s = new Set();
    for (const [a, e] of m) if (a !== o && strong(e) && !BURN.test(a) && count.get(a) <= SERVICE && ['wallet', '7702'].includes(kindOf(a))) s.add(a);
    out.set(o, s);
  }
  return out;
}

// One person = .ai wallets that share a tied wallet (or are tied to each other), plus those tied wallets.
// The face is its busiest .ai wallet. Returns { members: Map face -> [wallets], faceOf: Map wallet -> face }.
export function people(tieMap, isAi, weight = () => 0) {
  const up = new Map(), find = (a) => { while (up.has(a) && up.get(a) !== a) a = up.get(a); return a; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) up.set(b, a); };
  for (const [o, s] of tieMap) { find(o); for (const a of s) join(o, a); }
  const groups = new Map();
  for (const a of new Set([...tieMap.keys(), ...[...tieMap.values()].flatMap((s) => [...s])])) { const r = find(a); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(a); }
  const members = new Map(), faceOf = new Map();
  for (const l of groups.values()) {
    const ais = l.filter(isAi); if (!ais.length) continue;
    const face = ais.sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))[0];
    members.set(face, [face, ...l.filter((a) => a !== face).sort((a, b) => (isAi(b) - isAi(a)) || (a < b ? -1 : 1))]);
    for (const a of l) faceOf.set(a, face);
  }
  return { members, faceOf };
}

// What an address is, and who paid a wallet its first BNB (cached on disk; neither changes).
export function createLinker(rpc, { dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const KIND = path.join(dir, 'kinds.json'), FUND = path.join(dir, 'funders.json');
  const read = (f) => { try { return new Map(Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))); } catch { return new Map(); } };
  const kinds = read(KIND), funders = read(FUND);
  const write = (f, m) => fs.writeFileSync(f, JSON.stringify(Object.fromEntries(m)));

  async function kind(a) {
    if (kinds.has(a)) return kinds.get(a);
    let k;
    if (EXCHANGES.has(a)) k = 'exchange';
    else {
      const [code, n] = await Promise.all([rpc.code(a), rpc.nonce(a)]);
      k = code && code !== '0x' ? (code.toLowerCase().startsWith('0xef0100') ? '7702' : 'contract') : n > BUSY_NONCE ? 'exchange' : 'wallet';
    }
    kinds.set(a, k); write(KIND, kinds);
    return k;
  }

  // First block with a BNB balance (bisect on archive balances), then the plain transfer in that block that paid it.
  // lo/hi: hints (a block before it had any BNB, a block where it had some). Returns { from, block, tx, bnb } or
  // { from: null } (paid from inside a contract, e.g. some exchange withdrawals and bridges) or null (never had BNB).
  async function firstFunder(o, head, { lo: low = 0, hi: high = null } = {}) {
    if (funders.has(o)) return funders.get(o);
    const bal = async (b) => rpc.balance(o, b);
    const done = (v) => { funders.set(o, v); write(FUND, funders); return v; };
    let lo = 0, hi = head;
    if (high && await bal(high) > 0n) hi = high;
    else if (await bal(hi) === 0n) {   // emptied since: it held BNB just before its first own transaction
      if (!await rpc.nonce(o)) return done(null);
      let a = 0, b = head; while (b - a > 1) { const m = Math.floor((a + b) / 2); (await rpc.nonce(o, m)) >= 1 ? b = m : a = m; }
      hi = b - 1; if (await bal(hi) === 0n) return done(null);
    }
    if (low && low < hi && await bal(low) === 0n) lo = low;
    while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); (await bal(m)) > 0n ? hi = m : lo = m; }
    const blk = await rpc.block(hi, true);
    const tx = blk.transactions.find((t) => (t.to || '').toLowerCase() === o && BigInt(t.value) > 0n);
    return done(tx ? { from: tx.from.toLowerCase(), block: hi, t: parseInt(blk.timestamp, 16), tx: tx.hash, bnb: Number(BigInt(tx.value)) / 1e18 }
      : { from: null, block: hi, t: parseInt(blk.timestamp, 16) });
  }
  return { kind, firstFunder, kindOf: (a) => kinds.get(a) };
}
