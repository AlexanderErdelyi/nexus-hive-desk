import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncXliff } from './sync.ts';

// Minimal helpers to build XLIFF fixtures with consistent BC-style formatting.
function file(units: string, targetLang = 'de-DE'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en-US" target-language="${targetLang}" original="Sample">
    <body>
      <group id="body">
${units}
      </group>
    </body>
  </file>
</xliff>`;
}

function genUnit(id: string, source: string): string {
  return `        <trans-unit id="${id}" size-unit="char" translate="yes" xml:space="preserve">
          <source>${source}</source>
          <target>${source}</target>
          <note from="Xliff Generator" annotates="general" priority="3">${id}</note>
        </trans-unit>`;
}

function langUnit(id: string, source: string, target: string, state?: string, extraNote?: string): string {
  const stateAttr = state ? ` state="${state}"` : '';
  const noteLine = extraNote ? `\n          ${extraNote}` : '';
  return `        <trans-unit id="${id}" size-unit="char" translate="yes" xml:space="preserve">
          <source>${source}</source>
          <target${stateAttr}>${target}</target>
          <note from="Xliff Generator" annotates="general" priority="3">${id}</note>${noteLine}
        </trans-unit>`;
}

test('adds new units from the generated file with needs-translation state', () => {
  const generated = file([genUnit('A', 'Customer'), genUnit('B', 'Vendor')].join('\n'));
  const target = file(langUnit('A', 'Customer', 'Debitor'));

  const { xml, summary } = syncXliff(generated, target);

  assert.equal(summary.added, 1);
  assert.deepEqual(summary.addedIds, ['B']);
  assert.equal(summary.unchanged, 1);
  assert.match(xml, /<trans-unit id="B"[\s\S]*?<target state="needs-translation"><\/target>/);
  // Existing translation preserved.
  assert.match(xml, /<trans-unit id="A"[\s\S]*?<target>Debitor<\/target>/);
});

test('unchanged units are byte-for-byte preserved (zero diff)', () => {
  const units = [langUnit('A', 'Customer', 'Debitor'), langUnit('B', 'Vendor', 'Kreditor')];
  const generated = file([genUnit('A', 'Customer'), genUnit('B', 'Vendor')].join('\n'));
  const target = file(units.join('\n'));

  const { xml, summary, unchangedFile } = syncXliff(generated, target);

  assert.equal(summary.unchanged, 2);
  assert.equal(summary.added, 0);
  assert.equal(unchangedFile, true);
  assert.equal(xml, target);
});

test('source change keeps translation but updates source and flags for review', () => {
  const generated = file(genUnit('A', 'Customer Name'));
  const target = file(langUnit('A', 'Customer', 'Debitor'));

  const { xml, summary } = syncXliff(generated, target);

  assert.equal(summary.updated, 1);
  assert.deepEqual(summary.updatedIds, ['A']);
  assert.match(xml, /<source>Customer Name<\/source>/);
  assert.match(xml, /<target state="needs-review-translation">Debitor<\/target>/);
});

test('orphans are preserved by default (add-only)', () => {
  const generated = file(genUnit('A', 'Customer'));
  const target = file([langUnit('A', 'Customer', 'Debitor'), langUnit('OLD', 'Removed', 'Entfernt')].join('\n'));

  const { xml, summary } = syncXliff(generated, target);

  assert.equal(summary.orphansPreserved, 1);
  assert.equal(summary.orphansRemoved, 0);
  assert.match(xml, /<trans-unit id="OLD"/);
});

test('orphans are removed when removeOrphans is true', () => {
  const generated = file(genUnit('A', 'Customer'));
  const target = file([langUnit('A', 'Customer', 'Debitor'), langUnit('OLD', 'Removed', 'Entfernt')].join('\n'));

  const { xml, summary } = syncXliff(generated, target, { removeOrphans: true });

  assert.equal(summary.orphansRemoved, 1);
  assert.deepEqual(summary.removedIds, ['OLD']);
  assert.doesNotMatch(xml, /<trans-unit id="OLD"/);
});

test('pinned (NexusCustom) units survive a full sync with removeOrphans', () => {
  const pinNote = '<note from="NexusCustom" annotates="general" priority="2">Base app override</note>';
  const generated = file(genUnit('A', 'Customer'));
  const target = file(
    [langUnit('A', 'Customer', 'Debitor'), langUnit('BASE', 'Release', 'Freigeben', 'translated', pinNote)].join('\n'),
  );

  const { xml, summary } = syncXliff(generated, target, { removeOrphans: true });

  assert.equal(summary.pinnedPreserved, 1);
  assert.equal(summary.orphansRemoved, 0);
  assert.match(xml, /<trans-unit id="BASE"[\s\S]*?Freigeben/);
});

test('prefill hook fills new units from an exact TM match as translated', () => {
  const generated = file(genUnit('B', 'Vendor'));
  const target = file(langUnit('A', 'Customer', 'Debitor'));

  const { xml, summary } = syncXliff(generated, target, {
    prefill: (source) => (source === 'Vendor' ? { target: 'Kreditor' } : null),
  });

  assert.equal(summary.prefilled, 1);
  assert.match(xml, /<trans-unit id="B"[\s\S]*?<target state="translated">Kreditor<\/target>/);
});

test('canonicalOrder sorts units by id deterministically', () => {
  const generated = file([genUnit('C', 'Three'), genUnit('A', 'One'), genUnit('B', 'Two')].join('\n'));
  const target = file(
    [langUnit('C', 'Three', 'Drei'), langUnit('A', 'One', 'Eins'), langUnit('B', 'Two', 'Zwei')].join('\n'),
  );

  const { xml } = syncXliff(generated, target, { canonicalOrder: true });

  const order = [...xml.matchAll(/<trans-unit id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['A', 'B', 'C']);
});

test('entity-encoded sources are compared decoded (no false source change)', () => {
  const generated = file(genUnit('A', 'A &amp; B'));
  const target = file(langUnit('A', 'A &amp; B', 'A und B'));

  const { summary } = syncXliff(generated, target);

  assert.equal(summary.unchanged, 1);
  assert.equal(summary.updated, 0);
});
