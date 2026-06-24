import * as vscode from 'vscode';

/** UTF-8 BOM as a string (one code unit). */
export const UTF8_BOM = '\uFEFF';

/** Strip a leading UTF-8 BOM from already-decoded text. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Ensure the file at `uri` is stored as UTF-8 **with** a byte-order mark.
 *
 * Business Central's AL compiler reads translation `.xlf` files using the
 * machine's OEM code page when the file has no BOM, which mangles umlauts into
 * mojibake (e.g. "Für" → "F├╝r", "Ländercode" → "L├ñndercode"). The bytes are
 * valid UTF-8 — BC just misdetects the encoding. Prepending the BOM forces
 * correct UTF-8 detection on every platform.
 *
 * Idempotent (no-op when a BOM is already present) and best-effort: a failure
 * here must never block a save.
 */
export async function ensureUtf8Bom(uri: vscode.Uri): Promise<void> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
    ) {
      return; // already UTF-8 with BOM
    }
    const withBom = new Uint8Array(bytes.length + 3);
    withBom[0] = 0xef;
    withBom[1] = 0xbb;
    withBom[2] = 0xbf;
    withBom.set(bytes, 3);
    await vscode.workspace.fs.writeFile(uri, withBom);
  } catch {
    /* best-effort: never fail a save because BOM normalisation hiccuped */
  }
}
