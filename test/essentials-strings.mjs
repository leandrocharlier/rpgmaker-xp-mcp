import assert from 'node:assert/strict';
import { load } from '../dist/vendor/marshal/index.js';

// Ruby Marshal fixtures, independent of this project's serializer.
const text = Buffer.from('Pokémon');
const string = [0x22, text.length + 5, ...text];
const encoded = [0x49, ...string, 6, 0x3a, 6, 0x45, 0x54];
const fixture = Buffer.from([4, 8, 0x5b, 7, ...encoded, 0x40, 6]);
for (const options of [{}, { string: 'utf8' }]) {
  assert.deepEqual(load(fixture, options), ['Pokémon', 'Pokémon']);
}
const binary = load(fixture, { string: 'binary' });
assert.deepEqual(Buffer.from(binary[0]), text);
assert.equal(binary[0], binary[1]);

// The encoding label is a separate object. Both references must survive.
const named = Buffer.from([4, 8, 0x5b, 8, 0x49, ...string, 6,
  0x3a, 13, ...Buffer.from('encoding'),
  0x22, 10, ...Buffer.from('UTF-8'), 0x40, 6, 0x40, 7]);
const decoded = load(named);
assert.equal(decoded[0], 'Pokémon');
assert.equal(decoded[1], 'Pokémon');
assert.equal(Buffer.from(decoded[2]).toString(), 'UTF-8');
assert.deepEqual(load(named, { string: 'utf8' }), ['Pokémon', 'Pokémon', 'UTF-8']);
console.log('PASS Essentials encoded strings, binary mode, and object references');
