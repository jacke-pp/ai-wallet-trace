// BNB/USDT by the minute, from Binance's public market data (no key). Used to price WBNB and native-BNB trades in USD.
import fs from 'node:fs';
import path from 'node:path';

export function createPrice({ dir, fetchJson = async (u) => (await fetch(u, { signal: AbortSignal.timeout(15_000) })).json() }) {
  const FILE = path.join(dir, 'bnb-1m.json');
  let minute; try { minute = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8'))).map(([k, v]) => [+k, v])); } catch { minute = new Map(); }
  let dirty = false;
  const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];

  async function bnbUsd(t) {
    const m = Math.floor(t / 60);
    if (!minute.has(m)) {
      let k = null;
      for (const h of HOSTS) { try { k = await fetchJson(`${h}/api/v3/klines?symbol=BNBUSDT&interval=1m&startTime=${m * 60_000}&limit=1000`); if (Array.isArray(k)) break; } catch {} }
      if (!Array.isArray(k)) throw new Error('could not read the BNB price from Binance (network blocked?)');
      for (const c of k) minute.set(Math.floor(c[0] / 60_000), Number(c[4]));
      if (!minute.has(m)) { let n = m; while (n > m - 30 && !minute.has(n)) n--; minute.set(m, minute.get(n) || Number(k.at(-1)?.[4]) || 0); }
      dirty = true;
    }
    return minute.get(m);
  }
  const save = () => { if (dirty) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(minute))); dirty = false; } };
  return { bnbUsd, save };
}
