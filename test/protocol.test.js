'use strict';

// Compares the JS parser with vectors generated from an independent struct-based reference.
const assert = require('assert');
const P = require('../lib/NovyProtocol');
const vectors = require('./vectors.json');

for (const v of vectors) {
  const b16 = Buffer.from(v.b16, 'hex');
  const b20 = Buffer.from(v.b20, 'hex');
  const a = P.parse400(b16);
  for (const k of Object.keys(v.p400)) assert.strictEqual(a[k], v.p400[k], `400.${k} ${v.b16}`);
  for (const [fn, key] of [[P.parse402, 'p402'], [P.parse403, 'p403'], [P.parse404, 'p404']]) {
    const r = fn(b20);
    for (const k of Object.keys(v[key])) assert.strictEqual(r[k], v[key][k], `${key}.${k} ${v.b20}`);
  }
}

assert.strictEqual(P.buildFrame(28, 1, 75), '[28;1;75]');
assert.strictEqual(P.buildFrame(400, 0), '[400;0]');
assert.deepStrictEqual(P.parseRawCommand('[28;1;50]'), [28, 1, 50]);
assert.deepStrictEqual(P.parseRawCommand(' 25 1 1 '), [25, 1, 1]);
assert.throws(() => P.parseRawCommand('abc'));
assert.ok(P.isAck(Buffer.from('[1;1;1]')));
assert.ok(!P.isAck(Buffer.from('0a0b', 'hex')));

console.log(`protocol OK (${vectors.length} reference vectors)`);
