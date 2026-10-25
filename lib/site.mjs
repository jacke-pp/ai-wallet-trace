// No-node mode: ask agentidlive.ai, which already scans every .ai wallet on BSC and keeps the person board.
// Only .ai names (or their wallets) can be looked up this way; any other address needs your own node (--rpc).
export const SITE = 'https://agentidlive.ai';

export function createSite({ base = SITE, fetchImpl = globalThis.fetch } = {}) {
  async function get(p) {
    const r = await fetchImpl(base + p, { signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'ai-wallet-trace' } });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (r.status === 503 && j.error === 'warming up') throw new Error('agentidlive.ai is rebuilding its board right now, try again in a few minutes (or use your own node: --rpc)');
    if (j.error) throw new Error(`agentidlive.ai: ${j.error}`);
    return j;
  }
  const q = (s) => encodeURIComponent(String(s).trim().toLowerCase().replace(/\.ai$/, ''));
  return {
    trader: (s) => get(`/api/trader?q=${q(s)}`),     // rank, profit, tied wallets, latest trades
    privacy: (s) => get(`/api/privacy?q=${q(s)}`),   // first funder, holdings, who it moved coins with
    state: () => get('/api/state'),
  };
}
