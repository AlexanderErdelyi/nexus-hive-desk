import * as vscode from 'vscode';
import { createProvider } from '@nexus/ai';
import type { AIProvider } from '@nexus/ai';
import { CopilotProvider } from './copilotProvider';

const SECRET_KEY = 'nexus.translator.token';

export function getConfig() {
  const cfg = vscode.workspace.getConfiguration('nexus.translator');
  return {
    provider: cfg.get<string>('provider', 'github-copilot'),
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
  const config = getConfig();

  // GitHub Copilot: use the built-in VS Code LM API — no key required
  if (config.provider === 'github-copilot') {
    return new CopilotProvider(config.model);
  }

  const token = await getToken(context);
  if (!token) {
    const choice = await vscode.window.showErrorMessage(
      `Nexus Translator: No API token configured for "${config.provider}".`,
      'Switch to GitHub Copilot (no key needed)',
      'Set API Token'
    );
    if (choice === 'Switch to GitHub Copilot (no key needed)') {
      await vscode.workspace.getConfiguration('nexus.translator').update(
        'provider', 'github-copilot', vscode.ConfigurationTarget.Global
      );
      return new CopilotProvider(config.model);
    }
    if (choice === 'Set API Token') {
      await vscode.commands.executeCommand('nexus.setApiToken');
    }
    throw new Error('Translation cancelled: no API token configured.');
  }
  return createProvider({
    type: config.provider as Parameters<typeof createProvider>[0]['type'],
    token,
    model: config.model,
    baseURL: config.baseUrl,
  });
}
