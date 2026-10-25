// Local mode: everything read straight from your own BSC archive node.
//   who(q)  - the person behind a .ai wallet: the wallets tied to it, why, and what was left out
//   pnl(q)  - realized profit of that person (or one wallet), trade by trade, average cost
// Both cache what they read under the data dir, so a second look only reads new blocks.
import fs from 'node:fs';
import path from 'node:path';
import { createScanner } from './scan.mjs';
import { createRegistry, isName, cleanName, START } from './registry.mjs';
import { createLinker, ties, people, strong, SERVICE, BOT_LEGS, MIN_USD, MIN_COINS } from './people.mjs';
import { createPrice } from './price.mjs';
import { group, classify, createBook, medianPrice, MONEY, WBNB } from './book.mjs';
import { decode } from './abi.mjs';

const MIN_BNB = 0.0005, E18 = 1e18, APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const BURN = /^0x0{36}(0000|dead)$/;

export function createTracer(rpc, { dir, since = START, window, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const reg = createRegistry(rpc), scan = createScanner(rpc, { dir, window, log }), linker = createLinker(rpc, { dir }), price = createPrice({ dir });
  // chain facts that never change: BNB change over a block, block-clean checks, receipt matches, gas paid, symbols
  const CHAIN = path.join(dir, 'chain.json');
  let saved; try { saved = JSON.parse(fs.readFileSync(CHAIN, 'utf8')); } catch { saved = {}; }
  const memo = Object.fromEntries(['delta', 'clean', 'rcp', 'fee', 'sym', 'out'].map((k) => [k, new Map(Object.entries(saved[k] || {}))]));
  const save = () => { price.save(); fs.writeFileSync(CHAIN, JSON.stringify(Object.fromEntries(Object.entries(memo).map(([k, m]) => [k, Object.fromEntries(m)])))); };
  const once = async (k, key, fn) => { if (!memo[k].has(key)) memo[k].set(key, await fn()); return memo[k].get(key); };
  let head = null;
  const headNow = async () => head ??= await rpc.head();
  const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); };

  async function resolve(q) {
    q = String(q || '').trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(q)) return { o: q, name: (await reg.nameOf([q]))(q) || null };
    if (!isName(q)) throw new Error(`"${q}" is neither a 0x address nor a .ai name`);
    const o = await reg.ownerOf(q);
    if (!o) throw new Error(`nobody has claimed ${cleanName(q)}.ai`);
    return { o, name: cleanName(q) };
  }

  const rowsOf = async (list, label) => {
    const h = await headNow();
    return scan.transfers(list, since, h, (d, t) => log(`reading ${label}: ${Math.round(d / t * 100)}%`));
  };

  // rows of many wallets -> per wallet: trade legs { o, b, t, x, k, tok, q, usd?, give?, gq? }
  async function legsOf(rowsByWallet) {
    const owners = new Set(rowsByWallet.keys());
    const txs = group([...rowsByWallet.values()].flat(), (a) => owners.has(a));
    const out = new Map([...owners].map((o) => [o, []]));
    for (const [x, tx] of [...txs].sort((a, b) => a[1].b - b[1].b)) {
      const bnb = await price.bnbUsd(tx.t);
      for (const [o, g] of tx.legs) { const c = classify(g, bnb); if (c) out.get(o).push({ o, b: tx.b, t: tx.t, x, ...c }); }
    }
    return out;
  }

  // who o moved money and coins with: a -> { moneyIn, moneyOut (USD), coins: Map tok -> transfers out }
  async function flowOf(o, rows) {
    const m = new Map(), get = (a) => { if (!m.has(a)) m.set(a, { moneyIn: 0, moneyOut: 0, coins: new Map() }); return m.get(a); };
    const seen = new Set();
    for (const [, t, x, li, tok, from, to, amt] of rows) {
      if (seen.has(x + ':' + li)) continue; seen.add(x + ':' + li);
      const v = BigInt(amt); if (!v || from === to) continue;
      if (MONEY[tok]) {
        const usd = Number(v) / E18 * (tok === WBNB ? await price.bnbUsd(t) : 1); if (usd < 1) continue;
        if (from === o) get(to).moneyOut += usd; else if (to === o) get(from).moneyIn += usd;
      } else if (from === o) { const e = get(to); e.coins.set(tok, (e.coins.get(tok) || 0) + 1); }
    }
    return m;
  }
  // evidence for tying: { first, moneyIn, moneyOut, coinsOut } where coinsOut only counts coins o really bought
  function evidenceOf(flow, legs, funder) {
    const got = new Set(legs.filter((g) => g.k === 'buy' || g.k === 'in?' || g.k === 'swap').map((g) => g.tok));
    const ev = new Map();
    for (const [a, e] of flow) {
      let coinsOut = 0; for (const [tok, n] of e.coins) if (got.has(tok)) coinsOut += n;
      ev.set(a, { first: false, moneyIn: e.moneyIn, moneyOut: e.moneyOut, coinsOut });
    }
    if (funder) { if (!ev.has(funder)) ev.set(funder, { first: true, moneyIn: 0, moneyOut: 0, coinsOut: 0 }); else ev.get(funder).first = true; }
    return ev;
  }
  const why = (e) => [e.first && 'paid its first BNB', e.moneyIn >= MIN_USD && `sent it $${Math.round(e.moneyIn)}${e.bnb ? ' (incl. plain BNB)' : ''}`, e.moneyOut >= MIN_USD && `got $${Math.round(e.moneyOut)} from it`,
    e.coinsOut >= MIN_COINS && `got ${e.coinsOut} transfers of coins it bought`].filter(Boolean);

  // One .ai wallet's own picture: its legs, first funder and evidence.
  async function look(o, rows) {
    const legs = (await legsOf(new Map([[o, rows]]))).get(o);
    let fund = null;
    try { fund = await linker.firstFunder(o, await headNow(), { lo: since - 1, hi: rows[0]?.[0] }); } catch (e) { log(`first funder of ${o}: ${e.message}`); }
    return { legs, fund, ev: evidenceOf(await flowOf(o, rows), legs, fund?.from) };
  }

  // Plain BNB sends leave no log, so a main wallet that tops up its .ai wallets with BNB is invisible to the Transfer scan.
  // Its own transactions are found by bisecting its nonce on the archive node (~13 reads per transaction), then read from
  // their blocks. Skipped for wallets with more than `cap` transactions in the range: returns null.
  async function sentBnb(a, from, to, cap) {
    const key = a + ':' + from, c = memo.out.get(key) || { to: from, blocks: [] };
    if (c.to < to) {
      const [n0, n1] = await Promise.all([rpc.nonce(a, c.to), rpc.nonce(a, to)]);
      if (n1 - n0 > cap) return null;
      const hits = [];
      const split = async (lo, nlo, hi, nhi) => {
        if (nhi === nlo) return;
        if (hi - lo === 1) { hits.push(hi); return; }
        const m = Math.floor((lo + hi) / 2), nm = await rpc.nonce(a, m);
        await Promise.all([split(lo, nlo, m, nm), split(m, nm, hi, nhi)]);
      };
      await split(c.to, n0, to, n1);
      c.blocks.push(...hits.sort((x, y) => x - y)); c.to = to; memo.out.set(key, c);
    }
    const out = new Map();   // recipient -> USD of BNB sent
    await pool(c.blocks, 4, async (b) => {
      const blk = await rpc.block(b, true), bnb = await price.bnbUsd(parseInt(blk.timestamp, 16));
      for (const t of blk.transactions) if (t.from.toLowerCase() === a && t.to && BigInt(t.value) > 0n) {
        const r = t.to.toLowerCase(); out.set(r, (out.get(r) || 0) + Number(BigInt(t.value)) / E18 * bnb);
      }
    });
    return out;
  }

  async function who(q, { maxPeers = 20, bnbCap = 400 } = {}) {
    const { o, name } = await resolve(q);
    const rows = (await rowsOf([o], name || o)).get(o);
    const me = await look(o, rows);
    const cands = [...me.ev].filter(([a, e]) => strong(e) && a !== o).map(([a]) => a);
    const nameOf = await reg.nameOf([o, ...cands]);
    const kinds = new Map(), dropped = [];
    await pool(cands, 4, async (a) => kinds.set(a, BURN.test(a) ? 'burn' : nameOf(a) ? 'wallet' : await linker.kind(a)));
    // wallets that are people get a closer look: a bot, or a hub that many .ai wallets use, is not one person's
    const ppl = cands.filter((a) => ['wallet', '7702'].includes(kinds.get(a)) && !nameOf(a));
    const rowsP = ppl.length ? await rowsOf(ppl, `${ppl.length} tied wallets`) : new Map();
    const peers = new Map(), busy = [], bnbSent = new Map();   // tied wallet -> other .ai wallets it moved real money, coins or BNB with
    for (const a of ppl) {
      const r = rowsP.get(a);
      const bot = new Set(r.map((x) => x[2])).size > BOT_LEGS;
      if (bot) { kinds.set(a, 'bot'); continue; }
      const fl = await flowOf(a, r), seen = [...new Set(r.flatMap((x) => [x[5], x[6]]))].filter((p) => p !== a && p !== o), n = await reg.nameOf(seen);
      // a .ai wallet uses it when real money moved between them, or the .ai wallet sent it coins (checked properly below)
      const ais = seen.filter((p) => n(p) && (fl.get(p)?.moneyIn >= MIN_USD || fl.get(p)?.moneyOut >= MIN_USD
        || r.filter((x) => x[5] === p && x[6] === a && !MONEY[x[4]]).length >= MIN_COINS));
      // .ai wallets it sent plain BNB to (checked below: did it pay them their first BNB?)
      let sent = null;
      try { sent = await sentBnb(a, since, await headNow(), bnbCap); } catch (e) { log(`BNB sends of ${a}: ${e.message}`); }
      if (sent == null) busy.push(a);
      else {
        bnbSent.set(a, sent);
        const sn = await reg.nameOf([...sent.keys()]);
        for (const [p, v] of sent) if (p !== o && sn(p) && v >= MIN_USD && !ais.includes(p)) ais.push(p);
      }
      if (ais.length + 1 > SERVICE) { kinds.set(a, 'hub'); continue; }
      peers.set(a, ais);
    }
    for (const a of cands) if (!['wallet', '7702'].includes(kinds.get(a))) dropped.push({ o: a, kind: kinds.get(a), why: why(me.ev.get(a)) });
    const tieMap = ties(new Map([[o, me.ev]]), (a) => kinds.get(a) || 'contract');
    // other .ai wallets that share a tied wallet: check from their own side (real coins, their first funder)
    const others = new Map();
    const checks = [...new Set([...peers.values()].flat())].slice(0, maxPeers);
    if (checks.length) {
      const rowsO = await rowsOf(checks, `${checks.length} other .ai wallets`);
      for (const p of checks) {
        const pl = await look(p, rowsO.get(p));
        for (const [a, sent] of bnbSent) if (sent.get(p) >= MIN_USD) {   // plain BNB counts as real money too
          if (!pl.ev.has(a)) pl.ev.set(a, { first: false, moneyIn: 0, moneyOut: 0, coinsOut: 0 });
          pl.ev.get(a).moneyIn += sent.get(p); pl.ev.get(a).bnb = true;
        }
        const s = new Set([...pl.ev].filter(([a, e]) => strong(e) && tieMap.get(o).has(a)).map(([a]) => a));
        if (s.size) { tieMap.set(p, s); others.set(p, pl); }
      }
    }
    const isAi = (a) => a === o || !!nameOf(a) || others.has(a) || !!reg.known(a);
    const legsN = (a) => a === o ? me.legs.length : others.get(a)?.legs.length || 0;
    const { members } = people(tieMap, isAi, legsN);
    const unit = [...members.values()].find((l) => l.includes(o)) || [o];
    const wallets = unit.map((a) => ({ o: a, name: reg.known(a) || (a === o ? name : null) || null, ai: isAi(a),
      kind: a === o || others.has(a) ? 'wallet' : kinds.get(a), why: a === o ? ['the wallet you asked about'] : me.ev.has(a) ? why(me.ev.get(a))
      : others.has(a) ? [...tieMap.get(a)].map((t) => `${t.slice(0, 8)}… ${why(others.get(a).ev.get(t)).join(', ')}`) : ['tied through another .ai wallet'] }));
    const bought = new Set(me.legs.filter((g) => g.k === 'buy' || g.k === 'in?' || g.k === 'swap').map((g) => g.tok));
    const spam = rows.filter((x) => x[5] === o && !MONEY[x[4]] && !bought.has(x[4])).length;
    save();
    return { q, o, name, face: unit[0], wallets, dropped, funder: me.fund, transfers: rows.length, trades: me.legs.length, spam, notWalked: busy, since, head };
  }

  // ---- profit ----
  async function delta(o, b) {
    return once('delta', o + ':' + b, async () => { const [a, z] = await Promise.all([rpc.balance(o, b - 1), rpc.balance(o, b)]); return Number(z - a) / E18; });
  }
  const blocks = new Map();
  async function isClean(o, b, x) {
    return once('clean', o + ':' + b, async () => {
      let blk = blocks.get(b); if (!blk) { blk = await rpc.block(b, true); blocks.set(b, blk); if (blocks.size > 64) blocks.delete(blocks.keys().next().value); }
      const others = blk.transactions.filter((t) => t.hash.toLowerCase() !== x && (t.from.toLowerCase() === o || ((t.to || '').toLowerCase() === o && BigInt(t.value) > 0n)));
      for (const t of others) {
        if (t.from.toLowerCase() !== o || BigInt(t.value) > 0n) return false;
        if (t.input.startsWith('0x095ea7b3')) continue;
        const rc = await rpc.receipt(t.hash);
        if (rc.status !== '0x1' || rc.logs.every((l) => l.topics[0] === APPROVAL)) continue;
        return false;
      }
      return true;
    });
  }
  async function inReceipt(x, bnb) {   // the BNB we read from the balance must appear in the trade's own receipt, within 3%
    return once('rcp', x + ':' + bnb.toFixed(6), async () => {
      const [tx, rc] = await Promise.all([rpc.tx(x), rpc.receipt(x)]);
      const words = rc.logs.flatMap((l) => (l.data.slice(2).match(/.{64}/g) || []).map((w) => Number(BigInt('0x' + w)) / E18)).filter((v) => v > 0 && v < 1e7);
      words.push(Number(BigInt(tx.value)) / E18);
      return words.some((w) => Math.abs(w - bnb) <= bnb * 0.03);
    });
  }
  async function fee(o, x) {
    return once('fee', x, async () => {
      const [tx, rc] = await Promise.all([rpc.tx(x), rpc.receipt(x)]);
      return tx.from.toLowerCase() === o ? Number(BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice || tx.gasPrice)) / E18 : 0;
    });
  }
  async function symbol(t) {
    if (MONEY[t]) return MONEY[t];
    return once('sym', t, async () => {
      try {
        const r = await rpc.call(t, '0x95d89b41');
        try { return decode(['string'], r)[0].replace(/[^\p{L}\p{N} $._-]/gu, '').slice(0, 20) || t.slice(0, 8); }
        catch { return Buffer.from(r.slice(2, 66), 'hex').toString('utf8').replace(/\0/g, '').replace(/[^\p{L}\p{N} $._-]/gu, '') || t.slice(0, 8); }
      } catch { return t.slice(0, 8); }
    });
  }

  // Replay the wallets as one book. Coins moving between the person's own wallets keep their cost. A trade paid in
  // native BNB leaves no Transfer log, so it is read from the wallet's BNB change over that block, and only counted
  // when nothing else moved its BNB in that block and the amount shows up in the trade's own receipt.
  async function pnl(q, { solo = false, bnbCap } = {}) {
    const unit = solo ? { ...(await resolve(q)), wallets: null } : await who(q, { bnbCap });
    const ws = solo ? [unit.o] : unit.wallets.map((w) => w.o);
    const rows = await rowsOf(ws, ws.length > 1 ? `${ws.length} wallets` : unit.name || unit.o);
    const byW = await legsOf(rows);
    const list = [...byW.values()].flat().sort((a, b) => a.b - b.b || (a.x < b.x ? -1 : 1));
    const sides = new Map(), sameBlock = new Map();
    for (const g of list) if (g.k === 'in?' || g.k === 'out?') {
      sides.set(g.x + g.tok, (sides.get(g.x + g.tok) || 0) | (g.k === 'in?' ? 1 : 2));
      sameBlock.set(g.o + ':' + g.b, (sameBlock.get(g.o + ':' + g.b) || 0) + 1);
    }
    const own = (g) => ws.length > 1 && sides.get(g.x + g.tok) === 3;
    const later = new Set(list.flatMap((g) => g.k === 'sell' || g.k === 'out?' ? [g.tok] : g.k === 'swap' ? [g.give] : []));
    const unknown = list.filter((g) => !own(g) && (sameBlock.get(g.o + ':' + g.b) || 0) <= 1 && ((g.k === 'in?' && later.has(g.tok)) || g.k === 'out?'));
    let done = 0;
    await pool(unknown, 6, async (g) => { await delta(g.o, g.b); await isClean(g.o, g.b, g.x); if (++done % 25 === 0) log(`checking BNB trades: ${done}/${unknown.length}`); });
    // prices of the unit's own money trades, for coin-for-coin swaps
    const pts = new Map();
    for (const g of list) if ((g.k === 'buy' || g.k === 'sell') && g.usd >= 5 && g.q > 0n) { if (!pts.has(g.tok)) pts.set(g.tok, []); pts.get(g.tok).push([g.t, g.usd / Number(g.q), Number(g.q)]); }
    const worth = (tok, qq, t) => { const p = medianPrice(pts.get(tok) || [], t); return p == null ? null : Number(qq) * p; };
    const book = createBook(), skipped = [];
    const skip = (g, reason) => skipped.push({ o: g.o, t: g.t, x: g.x, k: g.k, tok: g.tok, why: reason });
    for (const g of list) {
      const o = g.o;
      if ((g.k === 'in?' || g.k === 'out?') && own(g)) continue;
      const solo1 = (sameBlock.get(o + ':' + g.b) || 0) <= 1;
      if (g.k === 'buy') book.buy(g.tok, g.q, g.usd, g.t, g.x, o);
      else if (g.k === 'sell') book.sell(g.tok, g.q, g.usd, g.t, g.x, o);
      else if (g.k === 'swap') {
        const a = worth(g.give, g.gq, g.t), b = worth(g.tok, g.q, g.t);
        const v = a != null && b != null ? (Math.max(a, b) <= 2 * Math.min(a, b) ? (a + b) / 2 : null) : a ?? b;
        if (v == null) { skip(g, 'coin-for-coin swap with no price'); book.moveOut(g.give, g.gq); continue; }
        book.sell(g.give, g.gq, v, g.t, g.x, o); book.buy(g.tok, g.q, v, g.t, g.x, o);
      } else if (g.k === 'in?') {
        if (!later.has(g.tok)) continue;
        if (!solo1) { skip(g, 'two unknown trades in one block'); continue; }
        if (!await isClean(o, g.b, g.x)) { skip(g, 'something else moved its BNB in that block'); continue; }
        const d0 = await delta(o, g.b), d = d0 + (d0 < -MIN_BNB / 4 ? await fee(o, g.x) : 0);
        if (d < -MIN_BNB && await inReceipt(g.x, -d)) book.buy(g.tok, g.q, -d * await price.bnbUsd(g.t), g.t, g.x, o);
        else skip(g, d < -MIN_BNB ? 'BNB amount not in the receipt' : 'arrived free (airdrop or transfer)');
      } else if (g.k === 'out?') {
        if (!book.holds(g.tok)) continue;
        if (!solo1) { skip(g, 'two unknown trades in one block'); book.moveOut(g.tok, g.q); continue; }
        if (!await isClean(o, g.b, g.x)) { skip(g, 'something else moved its BNB in that block'); book.moveOut(g.tok, g.q); continue; }
        const d0 = await delta(o, g.b), d = d0 + (d0 > MIN_BNB ? await fee(o, g.x) : 0);
        if (d > MIN_BNB && await inReceipt(g.x, d)) book.sell(g.tok, g.q, d * await price.bnbUsd(g.t), g.t, g.x, o);
        else { skip(g, d > MIN_BNB ? 'BNB amount not in the receipt' : 'sent away, no BNB back'); book.moveOut(g.tok, g.q); }
      }
    }
    const s = book.stats;
    const toks = new Set([...s.byTok.keys(), ...book.open().map((p) => p.tok)]);
    const syms = new Map(); await pool([...toks], 4, async (t) => syms.set(t, await symbol(t)));
    save();
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      q, o: unit.o, name: unit.name, wallets: ws, since,
      pnl: r2(s.pnl), cost: r2(s.cost), roi: s.cost ? r2(s.pnl / s.cost * 100) : 0, closes: s.closes, wins: s.wins, buys: s.buys, sells: s.sells, volume: r2(s.volume),
      coins: [...s.byTok].map(([tok, v]) => ({ tok, sym: syms.get(tok), pnl: r2(v.pnl), cost: r2(v.cost), closes: v.closes })).sort((a, b) => b.pnl - a.pnl),
      open: book.open().map((p) => ({ tok: p.tok, sym: syms.get(p.tok), cost: r2(p.cost) })).sort((a, b) => b.cost - a.cost),
      trades: s.trades.map((x) => ({ k: x.k, tok: x.tok, sym: syms.get(x.tok), usd: r2(x.usd), t: x.t, x: x.x, w: x.w, ...(x.gain != null ? { gain: r2(x.gain) } : {}) })),
      skipped,
    };
  }

  return { resolve, who, pnl, head: headNow };
}
