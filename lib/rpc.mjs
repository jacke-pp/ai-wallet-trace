// JSON-RPC over plain fetch: a request-rate cap, retries when the node is busy, and eth_getLogs that splits a block range
// the node refuses. Reads only: nothing in this package signs or sends a transaction.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RANGE = /range|block.?s? (?:range|limit)|max(?:imum)? results|more than \d+ results|too many results|query returned more|exceed.*(?:block|result|range)|limited to/i;
const BUSY = /rate.?limit|too many requests|limit exceeded|timeout|timed out|aborted|busy|ECONNRESET|ETIMEDOUT|fetch failed|socket|HTTP (?:429|5\d\d)|temporar/i;

export function createRpc(url, { rps = 10, timeoutMs = 25_000, fetchImpl = globalThis.fetch, retries = 6 } = {}) {
  if (!url) throw new Error('no RPC url');
  let id = 0, next = 0;
  const gate = async () => { const now = Date.now(), at = Math.max(now, next); next = at + 1000 / rps; if (at > now) await sleep(at - now); };

  async function send(method, params = []) {
    for (let i = 0; ; i++) {
      await gate();
      let msg;
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();
        let j; try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 80)}`); }
        if (!j.error) return j.result;
        const e = new Error(j.error.message || JSON.stringify(j.error)); e.code = j.error.code; e.data = j.error.data; throw e;
      } catch (e) {
        msg = String(e.message || e);
        if (RANGE.test(msg) || !BUSY.test(msg) || i >= retries) throw e;
      }
      await sleep(Math.min(15_000, 400 * 2 ** i));
    }
  }

  const hex = (n) => '0x' + BigInt(n).toString(16);
  // eth_getLogs over [from, to]; a range the node refuses is cut in half until it answers
  async function logs(filter, from, to, depth = 0) {
    try { return await send('eth_getLogs', [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }]); }
    catch (e) {
      if (depth > 14 || to <= from || !RANGE.test(String(e.message))) throw e;
      const m = Math.floor((from + to) / 2);
      return [...await logs(filter, from, m, depth + 1), ...await logs(filter, m + 1, to, depth + 1)];
    }
  }
  return {
    url, send, logs, hex,
    head: async () => parseInt(await send('eth_blockNumber'), 16),
    balance: async (a, b) => BigInt(await send('eth_getBalance', [a, b == null ? 'latest' : hex(b)])),
    nonce: async (a, b) => parseInt(await send('eth_getTransactionCount', [a, b == null ? 'latest' : hex(b)]), 16),
    code: (a) => send('eth_getCode', [a, 'latest']),
    call: (to, data, b) => send('eth_call', [{ to, data }, b == null ? 'latest' : hex(b)]),
    block: (b, full = false) => send('eth_getBlockByNumber', [hex(b), full]),
    tx: (h) => send('eth_getTransactionByHash', [h]),
    receipt: (h) => send('eth_getTransactionReceipt', [h]),
  };
}

export const isRangeError = (e) => RANGE.test(String(e?.message || e));
