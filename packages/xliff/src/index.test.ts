import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseXliff,
  serializeXliff,
  filterUnits,
  getXliffStats,
  type TranslationState,
  type XliffUnit,
} from './index.ts';

const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en-US" target-language="de-DE" original="Sample">
    <body>
      <group id="body">
        <trans-unit id="Table 1 - Field 2 - Property Caption" size-unit="char" translate="yes" xml:space="preserve">
          <source>Customer No.</source>
          <target>Debitorennr.</target>
          <note from="Developer" annotates="general" priority="2"></note>
          <note from="Xliff Generator" annotates="general" priority="3">Table My Table - Field Customer No.</note>
        </trans-unit>
        <trans-unit id="Table 1 - Field 3 - Property Caption" size-unit="char" translate="yes" xml:space="preserve">
          <source>Posting Date</source>
          <target state="needs-translation"></target>
          <note from="Developer" annotates="general" priority="2">Date the entry is posted</note>
        </trans-unit>
        <trans-unit id="Codeunit 5 - Method 1 - NamedType 1" size-unit="char" translate="yes" xml:space="preserve">
          <source>Process %1 of %2</source>
          <target>[NAB: REVIEW]Verarbeite %1 von %2</target>
        </trans-unit>
      </group>
    </body>
  </file>
</xliff>`;

test('parseXliff extracts languages and all units', () => {
  const parsed = parseXliff(SAMPLE);
  assert.equal(parsed.sourceLanguage, 'en-US');
  assert.equal(parsed.targetLanguage, 'de-DE');
  assert.equal(parsed.units.length, 3);
});

test('parseXliff reads source, target and developer notes', () => {
  const parsed = parseXliff(SAMPLE);
  const u = parsed.units[0];
  assert.equal(u.source, 'Customer No.');
  assert.equal(u.target, 'Debitorennr.');
  assert.equal(u.state, 'translated');

  const posting = parsed.units[1];
  assert.equal(posting.source, 'Posting Date');
  assert.equal(posting.target, '');
  assert.equal(posting.developerNote, 'Date the entry is posted');
});

test('parseXliff strips NAB prefixes and infers review state', () => {
  const parsed = parseXliff(SAMPLE);
  const u = parsed.units[2];
  assert.equal(u.source, 'Process %1 of %2');
  assert.equal(u.target, 'Verarbeite %1 von %2');
  assert.equal(u.state, 'needs-review-translation');
});

test('parseXliff strips a UTF-8 BOM', () => {
  const parsed = parseXliff('\uFEFF' + SAMPLE);
  assert.equal(parsed.units.length, 3);
  assert.equal(parsed.sourceLanguage, 'en-US');
});

test('serializeXliff returns the original untouched when there are no updates', () => {
  const out = serializeXliff(SAMPLE, new Map());
  assert.equal(out, SAMPLE);
});

test('serializeXliff patches only the targeted unit and preserves the rest', () => {
  const updates = new Map<string, { target: string; state: TranslationState }>([
    ['Table 1 - Field 3 - Property Caption', { target: 'Buchungsdatum', state: 'translated' }],
  ]);
  const out = serializeXliff(SAMPLE, updates);

  // The updated target is present without a state attr (translated => no attr).
  assert.match(out, /<target>Buchungsdatum<\/target>/);
  // Untouched units are byte-for-byte preserved.
  assert.match(out, /<target>Debitorennr\.<\/target>/);
  assert.match(out, /\[NAB: REVIEW\]Verarbeite %1 von %2/);
});

test('serializeXliff round-trips through parse with the new value', () => {
  const updates = new Map<string, { target: string; state: TranslationState }>([
    ['Table 1 - Field 3 - Property Caption', { target: 'Buchungsdatum', state: 'translated' }],
  ]);
  const reparsed = parseXliff(serializeXliff(SAMPLE, updates));
  const posting = reparsed.units.find((u) => u.id === 'Table 1 - Field 3 - Property Caption');
  assert.ok(posting);
  assert.equal(posting!.target, 'Buchungsdatum');
  assert.equal(posting!.state, 'translated');
});

test('serializeXliff escapes XML special characters in the target text', () => {
  const updates = new Map<string, { target: string; state: TranslationState }>([
    ['Table 1 - Field 2 - Property Caption', { target: 'A & B < C > D', state: 'translated' }],
  ]);
  const out = serializeXliff(SAMPLE, updates);
  assert.match(out, /A &amp; B &lt; C &gt; D/);
  // And it parses back to the original characters.
  const reparsed = parseXliff(out);
  const u = reparsed.units.find((x) => x.id === 'Table 1 - Field 2 - Property Caption');
  assert.equal(u!.target, 'A & B < C > D');
});

test('serializeXliff writes a state attribute for non-translated states', () => {
  const updates = new Map<string, { target: string; state: TranslationState }>([
    ['Table 1 - Field 2 - Property Caption', { target: 'Debitor', state: 'needs-review-translation' }],
  ]);
  const out = serializeXliff(SAMPLE, updates);
  assert.match(out, /<target state="needs-review-translation">Debitor<\/target>/);
});

const UNITS: XliffUnit[] = [
  { id: 'a', source: 'Apple', target: 'Apfel', state: 'translated', note: undefined, developerNote: undefined },
  { id: 'b', source: 'Banana', target: '', state: 'needs-translation', note: undefined, developerNote: undefined },
  { id: 'c', source: 'Cherry', target: 'Kirsche', state: 'needs-review-translation', note: undefined, developerNote: undefined },
  { id: 'd', source: 'Date', target: 'Dattel', state: 'final', note: undefined, developerNote: undefined },
];

test('filterUnits untranslatedOnly returns only empty/new units', () => {
  const r = filterUnits(UNITS, { untranslatedOnly: true });
  assert.deepEqual(r.map((u) => u.id), ['b']);
});

test('filterUnits by state set', () => {
  const r = filterUnits(UNITS, { states: ['translated', 'final'] });
  assert.deepEqual(r.map((u) => u.id), ['a', 'd']);
});

test('filterUnits search matches source, target and id, case-insensitively', () => {
  assert.deepEqual(filterUnits(UNITS, { search: 'kirsch' }).map((u) => u.id), ['c']);
  assert.deepEqual(filterUnits(UNITS, { search: 'APPLE' }).map((u) => u.id), ['a']);
  assert.deepEqual(filterUnits(UNITS, { search: 'b' }).map((u) => u.id).sort(), ['b']);
});

test('getXliffStats computes totals and progress', () => {
  const s = getXliffStats(UNITS);
  assert.equal(s.total, 4);
  assert.equal(s.translated, 2); // translated + final
  assert.equal(s.needsTranslation, 1);
  assert.equal(s.needsReview, 1);
  assert.equal(s.progress, 50);
});

test('getXliffStats handles an empty unit list', () => {
  const s = getXliffStats([]);
  assert.equal(s.total, 0);
  assert.equal(s.progress, 0);
});
