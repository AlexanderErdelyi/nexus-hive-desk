import * as vscode from 'vscode';
import type { AIProvider, AITranslateRequest, AITranslateResponse, AIReviewRequest, AIReviewResponse } from '@nexus/ai';
import type { AITranslateResult, AIReviewResult, AIReviewQuality, AIGlossarySuggestion, AIGlossaryGenerateRequest, AIGlossaryResponse, AIGlossaryPromptRequest } from '@nexus/types';

/**
 * AI provider that routes calls through the VS Code Language Model API
 * (GitHub Copilot). No API key is needed — it uses the user's existing
 * Copilot subscription / authentication.
 */
export class CopilotProvider implements AIProvider {
  readonly type = 'github-models' as const;
  readonly model: string;

  constructor(preferredModel?: string) {
    this.model = preferredModel || 'gpt-4o';
  }

  private async selectModel(): Promise<vscode.LanguageModelChat> {
    // Try to find the preferred model family, fall back to any available chat model
    const families = [this.model, 'gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet', 'o1-mini'];
    for (const family of families) {
      const models = await vscode.lm.selectChatModels({ family });
      if (models.length > 0) return models[0];
    }
    const all = await vscode.lm.selectChatModels();
    if (all.length > 0) return all[0];
    throw new Error(
      'No Copilot language model available. Make sure GitHub Copilot Chat is installed and signed in.'
    );
  }

  async translate(request: AITranslateRequest): Promise<AITranslateResponse> {
    const lm = await this.selectModel();

    const glossarySection =
      request.glossary && request.glossary.length > 0
        ? `\n\nGlossary (MUST follow these translations exactly):\n${request.glossary
            .map((g) => `  "${g.sourceTerm}" → "${g.targetTerm}"`)
            .join('\n')}`
        : '';

    const systemPrompt = `You are a professional software localization translator.
Translate UI strings from ${request.sourceLanguage} to ${request.targetLanguage}.
Rules:
- Preserve placeholders like %1, %2, {0}, {1}, &Text, etc. exactly as-is
- Preserve ampersand shortcuts (e.g. &Save)
- Keep technical terms, field names, and acronyms unchanged unless in glossary
- Be concise — UI strings are short
- Return ONLY a JSON object with a "translations" array of objects containing "id", "translation", and "confidence" fields
- "confidence" is a number 0–100 indicating your certainty${glossarySection}`;

    const userPrompt = `Translate these strings:\n${JSON.stringify(
      request.units.map((u) => ({ id: u.id, text: u.source }))
    )}`;

    const content = await this.chat(lm, systemPrompt, userPrompt);
    const parsed = parseJson<{ translations?: Array<{ id: string; translation: string; confidence?: number }> }>(content);
    const results: AITranslateResult[] = (parsed.translations ?? []).map((t) => {
      const score = typeof t.confidence === 'number' ? t.confidence : 85;
      const tier: 'high' | 'medium' | 'low' = score >= 90 ? 'high' : score >= 70 ? 'medium' : 'low';
      return { id: t.id, translatedText: t.translation, confidence: tier, confidenceScore: score };
    });

    return { results, provider: this.type, model: lm.name };
  }

  async review(request: AIReviewRequest): Promise<AIReviewResponse> {
    const lm = await this.selectModel();

    const glossarySection =
      request.glossary && request.glossary.length > 0
        ? `\n\nGlossary:\n${request.glossary.map((g) => `  "${g.sourceTerm}" → "${g.targetTerm}"`).join('\n')}`
        : '';

    const systemPrompt = `You are an expert Business Central localization quality reviewer.
Review ${request.sourceLanguage} → ${request.targetLanguage} UI string translations.
Check: semantic correctness, BC/ERP terminology, placeholder preservation, UI appropriateness, grammar.${glossarySection}

Return ONLY a JSON object:
{ "reviews": [{ "id": "...", "quality": "good"|"warning"|"error", "reason": "...", "suggestion": "..." }] }`;

    const userPrompt = `Review these translations:\n${JSON.stringify(
      request.units.map((u) => ({ id: u.id, source: u.source, target: u.target, ...(u.context ? { context: u.context } : {}) }))
    )}`;

    const content = await this.chat(lm, systemPrompt, userPrompt);
    const parsed = parseJson<{ reviews?: Array<{ id: string; quality: string; reason?: string; suggestion?: string }> }>(content);
    const results: AIReviewResult[] = (parsed.reviews ?? []).map((r) => ({
      id: r.id,
      quality: (r.quality as AIReviewQuality) || 'warning',
      reason: r.reason,
      suggestion: r.suggestion,
    }));

    return { results, provider: this.type, model: lm.name };
  }

  async generateGlossary(request: AIGlossaryGenerateRequest): Promise<AIGlossaryResponse> {
    const lm = await this.selectModel();
    const systemPrompt = `You are a Business Central localization expert. Analyze ${request.sourceLanguage} → ${request.targetLanguage} pairs and identify important BC-specific glossary terms.
Return ONLY JSON: { "suggestions": [{ "sourceTerm": "...", "targetTerm": "...", "description": "...", "confidence": "high"|"medium"|"low" }] }`;
    const userPrompt = `Analyze these translation samples:\n${JSON.stringify(request.samples.slice(0, 80).map((s: { source: string; target: string }) => ({ source: s.source, target: s.target })))}`;
    const content = await this.chat(lm, systemPrompt, userPrompt);
    const parsed = parseJson<{ suggestions?: AIGlossarySuggestion[] }>(content);
    return { suggestions: parsed.suggestions ?? [], provider: this.type, model: lm.name };
  }

  async suggestGlossaryFromPrompt(request: AIGlossaryPromptRequest): Promise<AIGlossaryResponse> {
    const lm = await this.selectModel();
    const systemPrompt = `You are a Business Central localization expert. Generate ${request.sourceLanguage} → ${request.targetLanguage} glossary entries from user instructions.
Return ONLY JSON: { "suggestions": [{ "sourceTerm": "...", "targetTerm": "...", "description": "...", "confidence": "high"|"medium"|"low" }] }`;
    const userPrompt = `Generate glossary entries for:\n${request.prompt}`;
    const content = await this.chat(lm, systemPrompt, userPrompt);
    const parsed = parseJson<{ suggestions?: AIGlossarySuggestion[] }>(content);
    return { suggestions: parsed.suggestions ?? [], provider: this.type, model: lm.name };
  }

  private async chat(lm: vscode.LanguageModelChat, system: string, user: string): Promise<string> {
    const messages = [
      vscode.LanguageModelChatMessage.User(`${system}\n\n${user}`),
    ];
    const response = await lm.sendRequest(messages, { justification: 'Nexus Translator: AI translation of XLIFF strings' });
    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }
    // Extract JSON from markdown code block if the model wrapped it
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    return fenced ? fenced[1].trim() : text.trim();
  }
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // Try to extract first { ... } block
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error(`Failed to parse AI response as JSON: ${text.slice(0, 200)}`);
  }
}
