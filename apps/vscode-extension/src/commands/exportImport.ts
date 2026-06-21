import * as vscode from 'vscode';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { parseXliff, serializeXliff } from '@nexus/xliff';
import type { TranslationState, XliffUnit } from '@nexus/types';
import { getConfig } from '../provider';
import { TranslationEditorProvider } from '../translationEditor';

const SHEET_NAME = 'Translations';
const README_SHEET = 'Read me';

const VALID_STATES: TranslationState[] = [
  'new',
  'needs-translation',
  'needs-review-translation',
  'translated',
  'final',
  'signed-off',
];

// Column layout (1-based). Editable columns are unlocked for the customer.
const COL = {
  id: 1,
  context: 2,
  devNote: 3,
  source: 4,
  target: 5, // editable
  state: 6, // editable
  comment: 7, // editable
} as const;

// ─── Shared helpers ─────────────────────────────────────────────────────────────

/** Resolve the .xlf URI from an explicit arg, the active text editor, or the active custom editor tab. */
function resolveXlfUri(uri?: vscode.Uri): vscode.Uri | undefined {
  if (uri && uri.fsPath.toLowerCase().endsWith('.xlf')) return uri;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.fsPath.toLowerCase().endsWith('.xlf')) return active;
  // Active custom editor tab (Nexus editor) — read from the tab input.
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input as { uri?: vscode.Uri } | undefined;
  if (input?.uri && input.uri.fsPath.toLowerCase().endsWith('.xlf')) {
    return vscode.Uri.file(input.uri.fsPath);
  }
  return undefined;
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'richText' in v && Array.isArray((v as ExcelJS.CellRichTextValue).richText)) {
    return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
  }
  return cell.text ?? String(v);
}

// ─── Export ──────────────────────────────────────────────────────────────────────

interface ExportOptions {
  filteredIds?: string[];
  isFiltered?: boolean;
  filterDesc?: string;
}

async function exportForReview(uriArg?: vscode.Uri, options?: ExportOptions): Promise<void> {
  const xlfUri = resolveXlfUri(uriArg);
  if (!xlfUri) {
    vscode.window.showErrorMessage('Open or select an .xlf file to export for review.');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(xlfUri);
  if (doc.isDirty) {
    const pick = await vscode.window.showWarningMessage(
      'This translation file has unsaved changes. Save before exporting so the review file is up to date?',
      { modal: true },
      'Save & Export'
    );
    if (pick !== 'Save & Export') return;
    await doc.save();
  }

  let parsed;
  try {
    parsed = parseXliff(doc.getText());
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Failed to parse XLIFF: ${(err as Error).message}`);
    return;
  }

  // Decide which units to export: all, or only the currently-filtered subset.
  let units = parsed.units;
  let scopeSuffix = '';
  if (options?.isFiltered && options.filteredIds && options.filteredIds.length > 0) {
    const filteredSet = new Set(options.filteredIds);
    const subset = parsed.units.filter((u) => filteredSet.has(u.id));
    if (subset.length > 0 && subset.length < parsed.units.length) {
      const filteredLabel = `Filtered units (${subset.length})${options.filterDesc ? ` — ${options.filterDesc}` : ''}`;
      const allLabel = `All units (${parsed.units.length})`;
      const choice = await vscode.window.showQuickPick(
        [
          { label: filteredLabel, value: 'filtered' as const },
          { label: allLabel, value: 'all' as const },
        ],
        { placeHolder: 'Which translations do you want to export for review?' }
      );
      if (!choice) return;
      if (choice.value === 'filtered') {
        units = subset;
        scopeSuffix = '.filtered';
      }
    }
  }

  const cfg = getConfig();
  const srcLang = parsed.sourceLanguage || cfg.sourceLanguage;
  const tgtLang = parsed.targetLanguage || cfg.targetLanguage;
  const base = path.basename(xlfUri.fsPath, path.extname(xlfUri.fsPath));

  const defaultName = `${base}${scopeSuffix}.review.xlsx`;
  const saveUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(xlfUri.fsPath), defaultName)),
    filters: { 'Excel Workbook': ['xlsx'] },
    saveLabel: 'Export for Review',
  });
  if (!saveUri) return;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nexus Translator';
  wb.created = new Date();

  // ── Read me sheet ──
  const readme = wb.addWorksheet(README_SHEET);
  readme.getColumn(1).width = 100;
  const lines = [
    'Translation review — how to use this file',
    '',
    `Source language: ${srcLang}    Target language: ${tgtLang}`,
    `File: ${path.basename(xlfUri.fsPath)}`,
    scopeSuffix ? `Scope: filtered subset — ${units.length} of ${parsed.units.length} units${options?.filterDesc ? ` (${options.filterDesc})` : ''}` : `Scope: all ${units.length} units`,
    '',
    '1. Go to the "Translations" sheet.',
    `2. Edit the "Translation (${tgtLang})" column where the wording should change.`,
    '3. Optionally set the "State" column (dropdown) and add a "Comment".',
    '4. Do NOT change the "ID", "Context" or "Source" columns — they are locked and used to match rows on import.',
    '5. Save the file and send it back. We import it to update the translations.',
    '',
    'Tip: leave a cell empty to keep the existing translation unchanged.',
  ];
  lines.forEach((t, i) => {
    const c = readme.getCell(i + 1, 1);
    c.value = t;
    if (i === 0) c.font = { bold: true, size: 14 };
  });

  // ── Translations sheet ──
  const ws = wb.addWorksheet(SHEET_NAME, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = [
    { header: 'ID', key: 'id', width: 22 },
    { header: 'Context', key: 'context', width: 40 },
    { header: 'Developer Note', key: 'devNote', width: 30 },
    { header: `Source (${srcLang})`, key: 'source', width: 50 },
    { header: `Translation (${tgtLang})`, key: 'target', width: 50 },
    { header: 'State', key: 'state', width: 22 },
    { header: 'Comment', key: 'comment', width: 30 },
  ];

  // Header styling
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.alignment = { vertical: 'middle' };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B579A' } };
    cell.protection = { locked: true };
  });
  header.height = 20;

  for (const u of units) {
    const row = ws.addRow({
      id: u.id,
      context: u.note || '',
      devNote: u.developerNote || '',
      source: u.source || '',
      target: u.target || '',
      state: u.state || '',
      comment: '',
    });
    row.alignment = { vertical: 'top', wrapText: true };
    // Lock reference columns, unlock editable ones.
    [COL.id, COL.context, COL.devNote, COL.source].forEach((ci) => {
      row.getCell(ci).protection = { locked: true };
    });
    [COL.target, COL.state, COL.comment].forEach((ci) => {
      row.getCell(ci).protection = { locked: false };
    });
    // State dropdown
    row.getCell(COL.state).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`"${VALID_STATES.join(',')}"`],
      showErrorMessage: true,
      errorTitle: 'Invalid state',
      error: `Choose one of: ${VALID_STATES.join(', ')}`,
    };
    // Tint editable target cell lightly so the customer sees where to type.
    row.getCell(COL.target).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFF8E1' },
    };
  }

  // Protect the sheet: locked cells can't be edited, unlocked ones can.
  await ws.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertRows: false,
    deleteRows: false,
    sort: true,
    autoFilter: true,
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COL.comment } };

  try {
    await wb.xlsx.writeFile(saveUri.fsPath);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Could not write Excel file: ${(err as Error).message}`);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Exported ${units.length} unit${units.length !== 1 ? 's' : ''}${scopeSuffix ? ' (filtered subset)' : ''} to ${path.basename(saveUri.fsPath)} for customer review.`,
    'Reveal in Explorer'
  );
  if (choice === 'Reveal in Explorer') {
    await vscode.commands.executeCommand('revealFileInOS', saveUri);
  }
}

// ─── Import ────────────────────────────────────────────────────────────────────

interface ImportSummary {
  updated: number;
  unchanged: number;
  notFound: number;
  notFoundIds: string[];
}

async function importReview(uriArg?: vscode.Uri): Promise<void> {
  const xlfUri = resolveXlfUri(uriArg);
  if (!xlfUri) {
    vscode.window.showErrorMessage('Open or select the .xlf file you want to update from a review file.');
    return;
  }

  const picks = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Excel Workbook': ['xlsx'] },
    defaultUri: vscode.Uri.file(path.dirname(xlfUri.fsPath)),
    openLabel: 'Import Review',
    title: `Import reviewed translations into ${path.basename(xlfUri.fsPath)}`,
  });
  if (!picks || picks.length === 0) return;
  const reviewPath = picks[0].fsPath;

  const doc = await vscode.workspace.openTextDocument(xlfUri);
  if (doc.isDirty) {
    vscode.window.showErrorMessage(
      'The translation file has unsaved changes. Save or discard them before importing a review file.'
    );
    return;
  }

  let parsed;
  try {
    parsed = parseXliff(doc.getText());
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Failed to parse XLIFF: ${(err as Error).message}`);
    return;
  }
  const unitById = new Map<string, XliffUnit>(parsed.units.map((u) => [u.id, u]));

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(reviewPath);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Could not read Excel file: ${(err as Error).message}`);
    return;
  }

  const ws = wb.getWorksheet(SHEET_NAME) ?? wb.worksheets.find((w) => w.name !== README_SHEET) ?? wb.worksheets[0];
  if (!ws) {
    vscode.window.showErrorMessage('No worksheet found in the review file.');
    return;
  }

  // Map header names → column indexes so column order changes don't break import.
  const colIndex: Record<string, number> = {};
  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell, col) => {
    const h = cellText(cell).trim().toLowerCase();
    if (h === 'id') colIndex.id = col;
    else if (h.startsWith('translation')) colIndex.target = col;
    else if (h === 'state') colIndex.state = col;
  });
  if (colIndex.id === undefined || colIndex.target === undefined) {
    vscode.window.showErrorMessage(
      'The review file must have "ID" and "Translation" columns. Use a file produced by "Export for Review".'
    );
    return;
  }

  const changes = new Map<string, { target: string; state: TranslationState }>();
  const summary: ImportSummary = { updated: 0, unchanged: 0, notFound: 0, notFoundIds: [] };

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const id = cellText(row.getCell(colIndex.id)).trim();
    if (!id) return;
    const unit = unitById.get(id);
    if (!unit) {
      summary.notFound++;
      if (summary.notFoundIds.length < 20) summary.notFoundIds.push(id);
      return;
    }

    const newTarget = cellText(row.getCell(colIndex.target));
    // Empty target means "keep existing" — never wipe a translation on import.
    if (newTarget.trim() === '') {
      summary.unchanged++;
      return;
    }

    let newState: TranslationState | undefined;
    if (colIndex.state !== undefined) {
      const s = cellText(row.getCell(colIndex.state)).trim() as TranslationState;
      if (VALID_STATES.includes(s)) newState = s;
    }

    const targetChanged = newTarget !== (unit.target || '');
    const finalState: TranslationState = newState ?? (targetChanged ? 'translated' : unit.state);

    if (!targetChanged && finalState === unit.state) {
      summary.unchanged++;
      return;
    }

    changes.set(id, { target: newTarget, state: finalState });
    summary.updated++;
  });

  if (changes.size === 0) {
    vscode.window.showInformationMessage(
      `Import complete — no changes applied. (${summary.unchanged} unchanged, ${summary.notFound} ID${summary.notFound !== 1 ? 's' : ''} not found.)`
    );
    return;
  }

  const proceed = await vscode.window.showWarningMessage(
    `Apply ${summary.updated} reviewed translation${summary.updated !== 1 ? 's' : ''} to ${path.basename(xlfUri.fsPath)}?` +
      (summary.notFound > 0 ? ` (${summary.notFound} row ID${summary.notFound !== 1 ? 's' : ''} not found and skipped.)` : ''),
    { modal: true },
    'Apply Changes'
  );
  if (proceed !== 'Apply Changes') return;

  const newContent = serializeXliff(doc.getText(), changes);
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
  edit.replace(xlfUri, fullRange, newContent);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    vscode.window.showErrorMessage('Failed to apply changes to the translation file.');
    return;
  }
  await doc.save();

  // Highlight the imported units in the open Nexus panel while preserving the
  // active filter. If the panel isn't open, fall back to a full refresh.
  const changeList = Array.from(changes.entries()).map(([id, c]) => ({
    id,
    target: c.target,
    state: c.state as string,
  }));
  if (!TranslationEditorProvider.applyImport(xlfUri, changeList)) {
    TranslationEditorProvider.refresh(xlfUri);
  }

  vscode.window.showInformationMessage(
    `Imported review: ${summary.updated} updated, ${summary.unchanged} unchanged` +
      (summary.notFound > 0 ? `, ${summary.notFound} not found` : '') + '.'
  );
}

// ─── Registration ──────────────────────────────────────────────────────────────

export function registerExportImport(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('nexus.exportForReview', (uri?: vscode.Uri, options?: ExportOptions) => exportForReview(uri, options)),
    vscode.commands.registerCommand('nexus.importReview', (uri?: vscode.Uri) => importReview(uri))
  );
}
