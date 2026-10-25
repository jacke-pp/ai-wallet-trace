// Binance Agent ID (.ai names) on BSC. A name is soulbound to the wallet that claimed it, so name <-> address is public:
//   name -> wallet:  ownerOf(keccak256(name))        (the name without ".ai")
//   wallet -> name:  handleOf(wallet)                 ("" when the wallet has none)
// Many wallets are looked up at once through Multicall3 (deployed at the same address on every EVM chain).
import { keccak256, encodeCall, decode } from './abi.mjs';

export const REGISTRY = '0x60b9262456de011f7d15a54cdd8c48baaa8b022f';
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
export const START = 128_724_651;   // first block of Agent ID claims (2026-10-20)

export const cleanName = (s) => String(s || '').trim().toLowerCase().replace(/\.ai$/, '');
export const isName = (s) => /^[a-z0-9]{1,32}$/.test(cleanName(s)) && !/^0x[0-9a-f]{40}$/.test(cleanName(s));

export function createRegistry(rpc) {
  const names = new Map();   // wallet -> name ('' = none)

  async function ownerOf(name) {
    const id = keccak256(new TextEncoder().encode(cleanName(name)));   // bytes, so a name like "0xabc" is not read as hex
    try {
      const [o] = decode(['address'], await rpc.call(REGISTRY, encodeCall('ownerOf(uint256)', [BigInt(id)])));
      return /^0x0{40}$/.test(o) ? null : o.toLowerCase();
    } catch { return null; }   // reverts for a name nobody claimed
  }

  // wallet -> name for many wallets, 200 per Multicall3 call
  async function nameOf(list) {
    const want = [...new Set(list.map((a) => a.toLowerCase()))].filter((a) => !names.has(a));
    for (let i = 0; i < want.length; i += 200) {
      const part = want.slice(i, i + 200);
      const calls = part.map((a) => [REGISTRY, true, encodeCall('handleOf(address)', [a])]);
      const [res] = decode(['(bool,bytes)[]'], await rpc.call(MULTICALL3, encodeCall('aggregate3((address,bool,bytes)[])', [calls])));
      res.forEach(([ok, data], k) => {
        let n = '';
        if (ok && data && data.length > 2) { try { n = decode(['string'], data)[0]; } catch {} }
        names.set(part[k], cleanName(n));
      });
    }
    return (a) => names.get(a.toLowerCase()) || '';
  }

  return { ownerOf, nameOf, known: (a) => names.get(a.toLowerCase()) };
}
