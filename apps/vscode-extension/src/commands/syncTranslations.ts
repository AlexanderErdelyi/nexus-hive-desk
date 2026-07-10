import * as path from 'path';
import * as vscode from 'vscode';
import { parseXliff, syncXliff, type SyncSummary } from '@nexus/xliff';
import { getConfig } from '../provider';
import { getTmManager } from '../tmManager';
import { logInfo, logError } from '../log';

const BOM = 0xfeff;

interface LangFile {
  language: string;
  uri: vscode.Uri;
}

/** Resolve the generated <base>.g.xlf URI from the command arg, active editor, or a picker. */
async function resolveGeneratedUri(arg?: unknown): Promise<vscode.Uri | undefined> {
  if (arg instanceof vscode.Uri && arg.fsPath.toLowerCase().endsWith('.g.xlf')) return arg;
  const active = vscode.window.activeTextEditor;
  if (active && active.document.fileName.toLowerCase().endsWith('.g.xlf')) return active.document.uri;

  const found = await vscode.workspace.findFiles('**/*.g.xlf', '**/node_modules/**', 50);
  if (found.length === 0) {
    vscode.window.showErrorMessage(
      'Nexus Translator: No generated base file (*.g.xlf) found. Build the AL app first, then run sync.',
    );
    return undefined;
  }
  if (found.length === 1) return found[0];
  const pick = await vscode.window.showQuickPick(
    found.map((u) => ({ label: path.basename(u.fsPath), description: vscode.workspace.asRelativePath(u), uri: u })),
    { title: 'Nexus: select the generated base file to sync from', placeHolder: '<App>.g.xlf' },
  );
  return pick?.uri;
}

/** Find sibling <base>.<lang>.xlf files next to the generated file. */
async function findLanguageFiles(genUri: vscode.Uri): Promise<LangFile[]> {
  const dir = vscode.Uri.file(path.dirname(genUri.fsPath));
  const genName = path.basename(genUri.fsPath);
  const base = genName.slice(0, -'.g.xlf'.length);
  const out: LangFile[] = [];
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return out;
  }
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File) continue;
    if (name === genName) continue;
    if (!name.startsWith(base + '.') || !name.toLowerCase().endsWith('.xlf')) continue;
    const lang = name.slice(base.length + 1, name.length - '.xlf'.length);
    if (!lang || lang.toLowerCase() === 'g') continue;
    out.push({ language: lang, uri: vscode.Uri.file(path.join(dir.fsPath, name)) });
  }
  return out;
}

function decodeWithBom(bytes: Uint8Array): { text: string; hasBom: boolean } {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.charCodeAt(0) === BOM) text = text.slice(1);
  return { text, hasBom };
}

function encodeWithBom(text: string, hasBom: boolean): Uint8Array {
  return new TextEncoder().encode(hasBom ? '\uFEFF' + text : text);
}

export function registerSyncTranslations(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('nexus.syncTranslations', async (arg?: unknown) => {
      const genUri = await resolveGeneratedUri(arg);
      if (!genUri) return;

      let generatedXml: string;
      let srcLang = '';
      try {
        const bytes = await vscode.workspace.fs.readFile(genUri);
        generatedXml = decodeWithBom(bytes).text;
        srcLang = parseXliff(generatedXml).sourceLanguage || '';
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Nexus Translator: Failed to read generated file — ${(err as Error).message}`);
        return;
      }

      const langFiles = await findLanguageFiles(genUri);
      if (langFiles.length === 0) {
        vscode.window.showErrorMessage(
          `Nexus Translator: No language files (<base>.<lang>.xlf) found next to ${path.basename(genUri.fsPath)}.`,
        );
        return;
      }

      // Choose target languages.
      const langPick = await vscode.window.showQuickPick(
        langFiles.map((f) => ({ label: f.language, description: path.basename(f.uri.fsPath), picked: true, file: f })),
        {
          title: 'Nexus Sync — choose languages',
          placeHolder: 'Select the language files to sync',
          canPickMany: true,
        },
      );
      if (!langPick || langPick.length === 0) return;
      const selected = langPick.map((p) => p.file);

      // Choose sync mode.
      const modePick = await vscode.window.showQuickPick(
        [
          {
            label: '$(shield) Add-only (recommended)',
            detail: 'Add new units, keep everything else. Never deletes — safest for merges and custom overrides.',
            removeOrphans: false,
          },
          {
            label: '$(trash) Full sync',
            detail: 'Also remove units no longer generated. Units pinned with a NexusCustom note are still kept.',
            removeOrphans: true,
          },
        ],
        { title: 'Nexus Sync — mode', placeHolder: 'How should obsolete units be handled?' },
      );
      if (!modePick) return;
      const removeOrphans = modePick.removeOrphans;

      const config = getConfig();
      const tmManager = getTmManager(context);

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Nexus Sync', cancellable: false },
        async (progress) => {
          const totals: SyncSummary = {
            added: 0, updated: 0, unchanged: 0,
            orphansPreserved: 0, orphansRemoved: 0, pinnedPreserved: 0, prefilled: 0,
            addedIds: [], updatedIds: [], removedIds: [],
          };
          let writtenFiles = 0;
          let done = 0;

          for (const lf of selected) {
            progress.report({
              message: `${lf.language} (${done + 1}/${selected.length})…`,
              increment: (1 / selected.length) * 100,
            });
            try {
              const bytes = await vscode.workspace.fs.readFile(lf.uri);
              const { text: targetXml, hasBom } = decodeWithBom(bytes);
              const tgtLang = parseXliff(targetXml).targetLanguage || lf.language;

              // Build an exact-match TM prefill map for this language pair.
              const tmEntries = await tmManager.getAll(srcLang || config.sourceLanguage, tgtLang);
              const tmMap = new Map<string, string>();
              for (const e of tmEntries) {
                const key = (e.source ?? '').trim();
                if (key && e.target) tmMap.set(key, e.target);
              }
              const prefill = tmMap.size
                ? (source: string) => {
                    const hit = tmMap.get(source.trim());
                    return hit ? { target: hit } : null;
                  }
                : undefined;

              const { xml, summary, unchangedFile } = syncXliff(generatedXml, targetXml, {
                removeOrphans,
                canonicalOrder: true,
                prefill,
              });

              if (!unchangedFile) {
                await vscode.workspace.fs.writeFile(lf.uri, encodeWithBom(xml, hasBom));
                writtenFiles++;
              }

              totals.added += summary.added;
              totals.updated += summary.updated;
              totals.unchanged += summary.unchanged;
              totals.orphansPreserved += summary.orphansPreserved;
              totals.orphansRemoved += summary.orphansRemoved;
              totals.pinnedPreserved += summary.pinnedPreserved;
              totals.prefilled += summary.prefilled;
              logInfo(
                `Nexus Sync ${lf.language}: +${summary.added} added, ${summary.updated} source-changed, ` +
                  `${summary.prefilled} TM-prefilled, ${summary.orphansRemoved} removed, ${summary.pinnedPreserved} pinned.`,
              );
            } catch (err: unknown) {
              logError(`Nexus Sync failed for ${lf.language}`, err);
              vscode.window.showErrorMessage(`Nexus Sync: ${lf.language} failed — ${(err as Error).message}`);
            }
            done++;
          }

          const parts = [
            `${totals.added} added`,
            `${totals.updated} to review`,
            `${totals.prefilled} TM-filled`,
          ];
          if (removeOrphans) parts.push(`${totals.orphansRemoved} removed`, `${totals.pinnedPreserved} pinned kept`);
          vscode.window.showInformationMessage(
            `Nexus Sync ✓ ${writtenFiles} file(s) updated — ${parts.join(', ')}.`,
          );
        },
      );
    }),
  );
}
