import test from 'node:test';
import assert from 'node:assert/strict';
import { ties, people, strong } from '../lib/people.mjs';

const ev = (o) => ({ first: false, moneyIn: 0, moneyOut: 0, coinsOut: 0, ...o });
const kind = (k) => (a) => k[a] || 'wallet';

test('what ties a wallet', () => {
  assert.ok(strong(ev({ first: true })));
  assert.ok(strong(ev({ moneyOut: 20 })));
  assert.ok(!strong(ev({ moneyIn: 19.9 })));
  assert.ok(strong(ev({ coinsOut: 2 })));
  assert.ok(!strong(ev({ coinsOut: 1 })));
});
test('exchanges, contracts, burn addresses and hubs are never tied; 7702 wallets are', () => {
  const burn = '0x000000000000000000000000000000000000dead';
  const e = new Map([['ai1', new Map([['main', ev({ first: true })], ['cex', ev({ moneyIn: 500 })], ['dex', ev({ moneyOut: 99 })], [burn, ev({ coinsOut: 9 })], ['smart', ev({ moneyOut: 30 })]])]]);
  for (let i = 0; i < 7; i++) e.set('x' + i, new Map([['hub', ev({ moneyIn: 50 })]]));
  e.get('ai1').set('hub', ev({ moneyIn: 50 }));
  const t = ties(e, kind({ cex: 'exchange', dex: 'contract', smart: '7702' }));
  assert.deepEqual([...t.get('ai1')].sort(), ['main', 'smart']);
});
test('two .ai wallets sharing a main wallet are one person, the busiest is the face', () => {
  const t = new Map([['ai1', new Set(['main'])], ['ai2', new Set(['main'])], ['ai3', new Set()]]);
  const { members, faceOf } = people(t, (a) => a.startsWith('ai'), (a) => ({ ai1: 5, ai2: 50 })[a] || 0);
  assert.deepEqual(members.get('ai2'), ['ai2', 'ai1', 'main']);
  assert.equal(faceOf.get('main'), 'ai2');
  assert.deepEqual(members.get('ai3'), ['ai3']);
});
