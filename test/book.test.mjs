import test from 'node:test';
import assert from 'node:assert/strict';
import { group, classify, createBook, medianPrice, WBNB } from '../lib/book.mjs';

const ME = '0x' + '1'.repeat(40), POOL = '0x' + '2'.repeat(40), USDT = '0x55d398326f99059ff775485246999027b3197955', COIN = '0x' + 'c'.repeat(40), COIN2 = '0x' + 'd'.repeat(40);
const e18 = (n) => '0x' + (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString(16);
const row = (x, li, tok, from, to, amt) => [100, 1000, x, li, tok, from, to, e18(amt)];
const legs = (rows) => [...group(rows, (a) => a === ME).values()].map((t) => classify(t.legs.get(ME), 600));

test('USDT out + coin in is a buy, the reverse a sell', () => {
  const [buy, sell] = legs([row('0xa', 0, USDT, ME, POOL, 50), row('0xa', 1, COIN, POOL, ME, 1000), row('0xb', 0, COIN, ME, POOL, 1000), row('0xb', 1, USDT, POOL, ME, 80)]);
  assert.equal(buy.k, 'buy'); assert.equal(buy.usd, 50);
  assert.equal(sell.k, 'sell'); assert.equal(sell.usd, 80);
});
test('WBNB is priced in USD; coin-only legs wait for the BNB balance; coin for coin is a swap', () => {
  const [w, only, swap] = legs([row('0xa', 0, WBNB, ME, POOL, 0.1), row('0xa', 1, COIN, POOL, ME, 5), row('0xb', 0, COIN, POOL, ME, 5), row('0xc', 0, COIN, ME, POOL, 5), row('0xc', 1, COIN2, POOL, ME, 7)]);
  assert.equal(w.k, 'buy'); assert.equal(Math.round(w.usd), 60);
  assert.equal(only.k, 'in?');
  assert.equal(swap.k, 'swap'); assert.equal(swap.give, COIN); assert.equal(swap.tok, COIN2);
});
test('a transfer seen twice (two watched wallets) counts once; zero amounts are dropped', () => {
  const g = group([row('0xa', 0, COIN, POOL, ME, 5), row('0xa', 0, COIN, POOL, ME, 5), row('0xa', 1, COIN, POOL, ME, 0)], (a) => a === ME);
  assert.equal(g.get('0xa').legs.get(ME).in.get(COIN), 5n * 10n ** 18n);
});
test('average cost book: partial sells, coins with no cost, moved coins', () => {
  const b = createBook(), q = (n) => BigInt(n) * 10n ** 18n;
  b.buy(COIN, q(100), 10, 1); b.buy(COIN, q(100), 30, 2);       // 200 coins for $40
  assert.equal(b.sell(COIN, q(100), 50, 3), 30);                 // half the cost is $20
  b.moveOut(COIN, q(50));                                        // $10 of cost leaves with it
  assert.equal(b.sell(COIN, q(100), 20, 4), 20 * 0.5 - 10);     // only 50 coins had a cost
  assert.equal(b.sell(COIN2, q(1), 99, 5), null);                // never bought: no profit counted
  assert.equal(b.stats.closes, 2); assert.equal(b.stats.wins, 1); assert.equal(b.holds(COIN), false);
});
test('median price ignores dust and needs two trades', () => {
  assert.equal(medianPrice([[0, 5, 100]], 0), null);
  assert.equal(medianPrice([[0, 5, 100], [30, 5.1, 100], [60, 5.2, 100], [90, 51000, 0.02]], 30), 5.1);
  assert.equal(medianPrice([[0, 5, 100], [9000, 6, 100]], 0), null);   // outside 2 hours
});
