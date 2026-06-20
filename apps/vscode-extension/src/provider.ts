import * as vscode from 'vscode';
import { createProvider } from '@nexus/ai';
import type { AIProvider } from '@nexus/ai';

const SECRET_KEY = 'nexus.translator.token';

export function getConfig() {
  const cfg = vscode.workspace.getConfiguration('nexus.translator');
  return {
    provider: cfg.get<string>('provider', 'openai'),
    token: cfg.get<string>('token', ''),
    model: cfg.get<string>('model', '') || undefined,
    baseUrl: cfg.get<string>('baseUrl', '') || undefined,
    sourceLanguage: cfg.get<string>('sourceLanguage', 'en-US'),
    targetLanguage: cfg.get<string>('targetLanguage', 'de-DE'),
    batchSize: cfg.get<number>('batchSize', 50),
  };
}

/**
 * Retrieves the API token: checks VS Code secret storage first, falls back to
 * the plain-text setting so users aren't forced to migrate.
 */
export async function getToken(context: vscode.ExtensionContext): Promise<string> {
  const secret = await context.secrets.get(SECRET_KEY);
  if (secret) return secret;
  return getConfig().token;
}

export async function storeToken(context: vscode.ExtensionContext, token: string): Promise<void> {
  await context.secrets.store(SECRET_KEY, token);
}

export async function createAIProvider(context: vscode.ExtensionContext): Promise<AIProvider> {
  const token = await getToken(context);
  if (!token) {
    throw new Error(
      'Nexus Translator: API token is not configured. Run "Nexus: Set API Token (Secure)" or set nexus.translator.token in Settings.'
    );
  }
  const config = getConfig();
  return createProvider({
    type: config.provider as Parameters<typeof createProvider>[0]['type'],
    token,
    model: config.model,
    baseURL: config.baseUrl,
  });
}
