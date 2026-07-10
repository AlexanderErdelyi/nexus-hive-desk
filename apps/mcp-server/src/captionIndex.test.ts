import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseGeneratorNote,
  buildCaptionIndex,
  getObjectTranslations,
  lookupTranslation,
} from './captionIndex.js';

// ─── parseGeneratorNote ───────────────────────────────────────────────────────

test('parses an object-level caption note', () => {
  const p = parseGeneratorNote('Table Authorization - Property Caption');
  assert.deepEqual(p, {
    objectType: 'Table',
    objectName: 'Authorization',
    element: undefined,
    property: 'Caption',
  });
});

test('parses a field caption note', () => {
  const p = parseGeneratorNote('Table Authorization - Field Address - Property Caption');
  assert.deepEqual(p, {
    objectType: 'Table',
    objectName: 'Authorization',
    element: { kind: 'Field', name: 'Address' },
    property: 'Caption',
  });
});

test('parses a page control tooltip note', () => {
  const p = parseGeneratorNote('Page Sales Order - Control Posting Date - Property ToolTip');
  assert.deepEqual(p, {
    objectType: 'Page',
    objectName: 'Sales Order',
    element: { kind: 'Control', name: 'Posting Date' },
    property: 'ToolTip',
  });
});

test('parses an action caption note', () => {
  const p = parseGeneratorNote('Page Customer Card - Action Post - Property Caption');
  assert.equal(p?.element?.kind, 'Action');
  assert.equal(p?.element?.name, 'Post');
  assert.equal(p?.property, 'Caption');
});

test('strips quotes around multi-word element names', () => {
  const p = parseGeneratorNote('Page "Sales Order" - Field "Posting Date" - Property Caption');
  assert.equal(p?.objectName, 'Sales Order');
  assert.equal(p?.element?.name, 'Posting Date');
});

test('returns null for a code label (non-Property final segment)', () => {
  assert.equal(parseGeneratorNote('Codeunit Foo - Method Bar - NamedType Baz'), null);
});

test('returns null for a non-object first segment', () => {
  assert.equal(parseGeneratorNote('Something Random - Property Caption'), null);
});

test('returns null for empty / short notes', () => {
  assert.equal(parseGeneratorNote(''), null);
  assert.equal(parseGeneratorNote(undefined), null);
  assert.equal(parseGeneratorNote('Table Authorization'), null);
});

test('handles tableextension object type', () => {
  const p = parseGeneratorNote('TableExtension My Ext - Field Extra - Property Caption');
  assert.equal(p?.objectType, 'TableExtension');
  assert.equal(p?.element?.name, 'Extra');
});

// ─── build + lookup integration ───────────────────────────────────────────────

function makeXliff(target: string, state: string, targetLang = 'de-DE'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file datatype="xml" source-language="en-US" target-language="${targetLang}" original="Test">
    <body>
      <group id="body">
        <trans-unit id="t1" size-unit="char" translate="yes" xml:space="preserve">
          <source>Authorization</source>
          <target state="translated">Berechtigung</target>
          <note from="Xliff Generator" annotates="general" priority="3">Table Authorization - Property Caption</note>
        </trans-unit>
        <trans-unit id="t2" size-unit="char" translate="yes" xml:space="preserve">
          <source>Address</source>
          <target state="translated">Adresse</target>
          <note from="Xliff Generator" annotates="general" priority="3">Table Authorization - Field Address - Property Caption</note>
        </trans-unit>
        <trans-unit id="t3" size-unit="char" translate="yes" xml:space="preserve">
          <source>City</source>
          <target state="${state}">${target}</target>
          <note from="Xliff Generator" annotates="general" priority="3">Table Authorization - Field City - Property Caption</note>
        </trans-unit>
      </group>
    </body>
  </file>
</xliff>`;
}

function withWorkspace(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-capidx-'));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('builds an index and returns object translations', () => {
  withWorkspace((root) => {
    fs.writeFileSync(path.join(root, 'de-DE.xlf'), makeXliff('', 'needs-translation'), 'utf-8');
    const stats = buildCaptionIndex(root);
    assert.equal(stats.objectCount, 1);
    assert.equal(stats.elementCount, 2); // Address + City fields
    assert.ok(stats.languages.includes('de-DE'));

    const res = getObjectTranslations(root, 'Table', 'Authorization', 'de-DE');
    assert.ok(!('error' in res));
    if ('error' in res) return;
    assert.equal(res.object.caption, 'Berechtigung');
    assert.equal(res.object.translated, true);

    const address = res.elements.find((e) => e.name === 'Address');
    assert.equal(address?.caption, 'Adresse');
    assert.equal(address?.translated, true);

    // City is untranslated -> falls back to source, translated:false
    const city = res.elements.find((e) => e.name === 'City');
    assert.equal(city?.caption, 'City');
    assert.equal(city?.translated, false);
  });
});

test('lookupTranslation resolves a single field and an untranslated fallback', () => {
  withWorkspace((root) => {
    fs.writeFileSync(path.join(root, 'de-DE.xlf'), makeXliff('', 'needs-translation'), 'utf-8');
    buildCaptionIndex(root);

    const hit = lookupTranslation(root, {
      type: 'Table', name: 'Authorization', elementKind: 'Field', elementName: 'Address',
      property: 'Caption', language: 'de-DE',
    });
    assert.ok(!('error' in hit));
    if ('error' in hit) return;
    assert.equal(hit.found, true);
    assert.equal(hit.target, 'Adresse');
    assert.equal(hit.translated, true);

    const miss = lookupTranslation(root, {
      note: 'Table Authorization - Field City - Property Caption', language: 'de-DE',
    });
    assert.ok(!('error' in miss));
    if ('error' in miss) return;
    assert.equal(miss.translated, false);
    assert.equal(miss.source, 'City');
    assert.equal(miss.target, null);
  });
});

test('getObjectTranslations returns suggestions on a miss', () => {
  withWorkspace((root) => {
    fs.writeFileSync(path.join(root, 'de-DE.xlf'), makeXliff('Stadt', 'translated'), 'utf-8');
    buildCaptionIndex(root);
    const res = getObjectTranslations(root, 'Table', 'Nonexistent', 'de-DE');
    assert.ok('error' in res);
  });
});
