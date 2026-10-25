import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, isName, cleanName, MULTICALL3 } from '../lib/registry.mjs';
import { keccak256, encodeArgs, selector } from '../lib/abi.mjs';

test('names', () => {
  assert.equal(cleanName(' CZheyi.AI '), 'czheyi');
  assert.ok(isName('0xabc.ai'));      // a name that starts with 0x is still a name
  assert.ok(!isName('0x' + 'a'.repeat(40)));
  assert.ok(!isName('bad-name'));
});
test('ownerOf hashes the name as text, not hex', async () => {
  let sent;
  const owner = '0x' + 'ab'.repeat(20);
  const rpc = { call: async (to, data) => { sent = data; return encodeArgs(['address'], [owner]); } };
  assert.equal(await createRegistry(rpc).ownerOf('0xabc.ai'), owner);
  assert.equal(sent, selector('ownerOf(uint256)') + keccak256(new TextEncoder().encode('0xabc')).slice(2));
});
test('nameOf reads many wallets in one Multicall3 call', async () => {
  const a = '0x' + '1'.repeat(40), b = '0x' + '2'.repeat(40);
  let calls = 0;
  const rpc = { call: async (to) => { calls++; assert.equal(to, MULTICALL3);
    return encodeArgs(['(bool,bytes)[]'], [[[true, encodeArgs(['string'], ['Alice'])], [true, encodeArgs(['string'], [''])]]]); } };
  const name = await createRegistry(rpc).nameOf([a, b, a.toUpperCase().replace('0X', '0x')]);
  assert.equal(calls, 1); assert.equal(name(a), 'alice'); assert.equal(name(b), '');
});
