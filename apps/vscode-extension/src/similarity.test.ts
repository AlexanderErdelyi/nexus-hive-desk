import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levenshtein, similarity, FUZZY_THRESHOLD } from './similarity.ts';

test('levenshtein returns 0 for identical strings', () => {
  assert.equal(levenshtein('kitten', 'kitten'), 0);
});

test('levenshtein counts single-edit distances', () => {
  assert.equal(levenshtein('kitten', 'sitten'), 1); // substitution
  assert.equal(levenshtein('kitten', 'kittens'), 1); // insertion
  assert.equal(levenshtein('kitten', 'sitting'), 3);
});

test('levenshtein handles empty strings', () => {
  assert.equal(levenshtein('', ''), 0);
  assert.equal(levenshtein('abc', ''), 3);
  assert.equal(levenshtein('', 'abc'), 3);
});

test('similarity is 1 only for an exact case-sensitive match', () => {
  assert.equal(similarity('Customer No.', 'Customer No.'), 1);
});

test('similarity caps case-insensitive matches below 1', () => {
  const s = similarity('Customer No.', 'customer no.');
  assert.ok(s >= 0.99 && s < 1, `expected ~0.99, got ${s}`);
});

test('similarity short-circuits to 0 when lengths differ by >40%', () => {
  assert.equal(similarity('Hi', 'Hello there friend'), 0);
});

test('close strings score above the fuzzy threshold', () => {
  assert.ok(similarity('Posting Date', 'Posting Dates') >= FUZZY_THRESHOLD);
});

test('unrelated strings of similar length score below the fuzzy threshold', () => {
  assert.ok(similarity('Customer', 'Yardbiry') < FUZZY_THRESHOLD);
});

test('similarity is symmetric', () => {
  assert.equal(similarity('Invoice', 'Invoce'), similarity('Invoce', 'Invoice'));
});

test('FUZZY_THRESHOLD is the documented 0.75', () => {
  assert.equal(FUZZY_THRESHOLD, 0.75);
});
