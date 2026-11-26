// node bot/test/book.test.mjs  → exits 1 if the order-book parser can't read Kalshi's real reply.
// The fixture is a real KXBTC15M reply (Nov 24, 2026, from the Mac bot's trades.log).
import assert from 'node:assert/strict';
import { parseBook } from '../book.mjs';

const real = { orderbook_fp: {
  no_dollars: [['0.3900', '4240.42'], ['0.4000', '8189.28'], ['0.4100', '5602.77']],
  yes_dollars: [['0.5600', '11147.18'], ['0.5700', '10911.46'], ['0.5800', '13410.05']],
} };
assert.deepEqual(parseBook(real), { yesBid: 58, noBid: 41, yesAsk: 59, noAsk: 42 }, 'current orderbook_fp shape');

const old = { orderbook: { yes: [[56, 10], [57, 5]], no: [[40, 3], [41, 0]] } };
assert.deepEqual(parseBook(old), { yesBid: 57, noBid: 40, yesAsk: 60, noAsk: 43 }, 'old cents shape (empty levels ignored)');

// sub-cent dust bids (0.001) must not count as a 0c bid
const dust = { orderbook_fp: { no_dollars: [['0.0010', '4031011.14'], ['0.0500', '10']], yes_dollars: [['0.9400', '5']] } };
assert.deepEqual(parseBook(dust), { yesBid: 94, noBid: 5, yesAsk: 95, noAsk: 6 }, 'dust levels ignored');

assert.equal(parseBook({ orderbook_fp: { yes_dollars: [['0.5', '1']] } }), null, 'one empty side → null');
assert.equal(parseBook({}), null, 'nothing → null');
console.log('book.test: all passed');
