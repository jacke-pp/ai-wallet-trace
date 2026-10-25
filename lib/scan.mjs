// Every ERC-20 Transfer into or out of a set of wallets over a block range, cached on disk per wallet so a second look
// only reads the new blocks. A log is kept compact: [block, time, tx, logIndex, token, from, to, amount(hex)].
import fs from 'node:fs';
import path from 'node:path';

export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a) => '0x000000000000000000000000' + a.slice(2).toLowerCase();

export function createScanner(rpc, { dir, window = 10_000, batch = 50, log = () => {} }) {
  const cdir = path.join(dir, 'transfers');
  fs.mkdirSync(cdir, { recursive: true });
  const file = (a) => path.join(cdir, a.toLowerCase() + '.json');
  const load = (a) => { try { return JSON.parse(fs.readFileSync(file(a), 'utf8')); } catch { return null; } };
  const save = (a, c) => fs.writeFileSync(file(a), JSON.stringify(c));

  // block -> unix time. Logs from most nodes carry blockTimestamp; when one doesn't, time is read off the window's two
  // ends and filled in between (blocks are evenly spaced, so this is within a few seconds).
  const anchors = new Map();
  const timeAt = async (b) => { if (!anchors.has(b)) anchors.set(b, parseInt((await rpc.block(b)).timestamp, 16)); return anchors.get(b); };
  async function timeOf(b, lo, hi) {
    const [t0, t1] = [await timeAt(lo), await timeAt(hi)];
    return hi === lo ? t0 : Math.round(t0 + (t1 - t0) * (b - lo) / (hi - lo));
  }

  // Map wallet -> logs in [from, to]
  async function transfers(wallets, from, to, onProgress = () => {}) {
    const list = [...new Set(wallets.map((a) => a.toLowerCase()))];
    const cache = new Map(list.map((a) => [a, load(a)]));
    const need = new Map();   // first block still to read -> wallets
    for (const a of list) {
      const c = cache.get(a);
      const start = c && c.from <= from ? c.to + 1 : from;
      if (!c || c.from > from) cache.set(a, { from, to: from - 1, logs: [] });
      if (start <= to) { if (!need.has(start)) need.set(start, []); need.get(start).push(a); }
    }
    const total = [...need].reduce((s, [b, l]) => s + (to - b + 1) * Math.ceil(l.length / batch), 0);
    let done = 0;
    for (const [start, group] of need) {
      for (let i = 0; i < group.length; i += batch) {
        const part = group.slice(i, i + batch), pads = part.map(pad), set = new Set(part);
        const got = new Map(part.map((a) => [a, []]));
        for (let b = start; b <= to; b += window) {
          const e = Math.min(to, b + window - 1);
          const raw = [...await rpc.logs({ topics: [TRANSFER, pads] }, b, e), ...await rpc.logs({ topics: [TRANSFER, null, pads] }, b, e)];
          const seen = new Set();
          for (const l of raw) {
            if (l.removed || l.topics.length !== 3 || !l.data || l.data.length !== 66) continue;
            const key = l.transactionHash + ':' + l.logIndex; if (seen.has(key)) continue; seen.add(key);
            const bn = parseInt(l.blockNumber, 16);
            const t = l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : await timeOf(bn, b, e);
            const f = '0x' + l.topics[1].slice(26).toLowerCase(), r = '0x' + l.topics[2].slice(26).toLowerCase();
            const row = [bn, t, l.transactionHash.toLowerCase(), parseInt(l.logIndex, 16), l.address.toLowerCase(), f, r, l.data === '0x' + '0'.repeat(64) ? '0x0' : l.data];
            if (set.has(f)) got.get(f).push(row);
            if (set.has(r) && r !== f) got.get(r).push(row);
          }
          done += e - b + 1; onProgress(done, total);
        }
        for (const a of part) { const c = cache.get(a); c.logs.push(...got.get(a)); c.to = to; save(a, c); }
      }
    }
    const out = new Map();
    for (const a of list) out.set(a, cache.get(a).logs.filter((r) => r[0] >= from && r[0] <= to));
    return out;
  }
  return { transfers };
}
