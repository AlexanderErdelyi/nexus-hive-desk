import * as fs from 'fs';
import * as path from 'path';

export interface TmEntry {
  source: string;
  target: string;
  sourceLanguage: string;
  targetLanguage: string;
  usageCount: number;
  updatedAt: string;
}

export interface GlossaryEntry {
  id: string;
  sourceTerm: string;
  targetTerm: string;
  sourceLanguage: string;
  targetLanguage: string;
  description?: string;
  caseSensitive: boolean;
  createdAt: string;
}

export function getNexusDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.nexus');
}

export function readTm(workspaceRoot: string): TmEntry[] {
  const file = path.join(getNexusDir(workspaceRoot), 'tm.json');
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as TmEntry[];
  } catch {
    return [];
  }
}

export function writeTm(workspaceRoot: string, entries: TmEntry[]): void {
  const dir = getNexusDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tm.json'), JSON.stringify(entries, null, 2), 'utf-8');
}

export function readGlossary(workspaceRoot: string): GlossaryEntry[] {
  const file = path.join(getNexusDir(workspaceRoot), 'glossary.json');
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as GlossaryEntry[];
  } catch {
    return [];
  }
}

export function writeGlossary(workspaceRoot: string, entries: GlossaryEntry[]): void {
  const dir = getNexusDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'glossary.json'), JSON.stringify(entries, null, 2), 'utf-8');
}
