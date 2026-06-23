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

    const systemPrompt = `You are a professional Microsoft Dynamics 365 Business Central (BC) software localization translator.
Translate UI strings from ${request.sourceLanguage} to ${request.targetLanguage}.
Rules:
- Preserve placeholders like %1, %2, {0}, {1}, &Text, etc. exactly as-is
- Preserve ampersand shortcuts (e.g. &Save)
- Keep placeholders and genuine acronyms unchanged; do NOT leave ordinary English words untranslated just because they also appear as field/object names in the context
- Be concise — UI strings are short
- Use OFFICIAL Business Central terminology for the target language (e.g. en-US "Job Queue" → de-DE "Aufgabenwarteschlange", not "Job-Warteschlange")
- Each string may carry a "context" describing the BC object and property it belongs to, and an "AL source" snippet. USE THEM:
  - A Caption / Cue / field or column caption ⇒ translate as a short NOUN LABEL (a heading/field name), NOT a sentence. e.g. "Job Queue Errors" as a count-field caption ⇒ "Aufgabenwarteschlangenposten-Fehler", not "Fehler in der Warteschlange".
  - If the AL source shows the field type is Integer/Decimal/BigInteger (a count or number), the caption usually denotes a QUANTITY — phrase it accordingly (e.g. prefer "Anzahl ..." when it counts things).
  - A ToolTip / InstructionalText ⇒ a full descriptive sentence is appropriate.
  - The object type (Table/Page/Codeunit/Report) and object name indicate the functional domain — translate in that domain's wording.
  - IMPORTANT: the "context" and "AL source" contain English AL identifiers (object, field, control names like "E-Document"). They are CODE references to clarify MEANING and DATA TYPE ONLY. Do NOT copy English identifiers into the translation and do NOT preserve their English spelling. Always translate the user-facing source text using standard target-language BC terminology (e.g. "Document" ⇒ "Dokument", "E-Document" ⇒ "E-Dokument").
- When "references" (approved translations of similar strings) are given, MATCH their terminology and style closely.
- Return ONLY a JSON object with a "translations" array of objects containing "id", "translation", and "confidence" fields
- "confidence" is a number 0–100 indicating your certainty${glossarySection}`;

    const payload = request.units.map((u) => {
      const item: Record<string, unknown> = { id: u.id, text: u.source };
      if (u.context) item.context = u.context;
      if (u.references && u.references.length > 0) {
        item.references = u.references.map((r) => ({ source: r.source, approved: r.target }));
      }
      return item;
    });

    const userPreamble = `Translate these strings. Each item may include "context" (BC object/property metadata) and "references" (approved translations of similar strings) — use them to choose correct terminology and the right grammatical form:\n`;

    // The Copilot model enforces a per-request input token limit. A caller-chosen
    // batch (especially in Context mode, where each unit carries BC metadata + an AL
    // source snippet) can exceed it, so split the payload into token-sized sub-batches
    // that each fit, send them sequentially, and merge the results.
    const subBatches = await this.splitByTokenBudget(lm, systemPrompt, userPreamble, payload);

    const results: AITranslateResult[] = [];
    for (const items of subBatches) {
      const userPrompt = userPreamble + JSON.stringify(items);
      const content = await this.chat(lm, systemPrompt, userPrompt);
      const parsed = parseJson<{ translations?: Array<{ id: string; translation: string; confidence?: number }> }>(content);
      for (const t of parsed.translations ?? []) {
        const score = typeof t.confidence === 'number' ? t.confidence : 85;
        const tier: 'high' | 'medium' | 'low' = score >= 90 ? 'high' : score >= 70 ? 'medium' : 'low';
        results.push({ id: t.id, translatedText: t.translation, confidence: tier, confidenceScore: score });
      }
    }

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
Check: semantic correctness, BC/ERP terminology, placeholder preservation, UI appropriateness, grammar.
Each item may carry a "context" describing the BC object/property and an "AL source" snippet. USE THEM:
- A Caption / Cue / field or column caption must read as a short NOUN LABEL, not a sentence.
- If the AL source shows the field type is Integer/Decimal/BigInteger (a count/number), the caption denotes a QUANTITY — flag generic phrasings and suggest a count-style label (e.g. "Anzahl …").
- A ToolTip / InstructionalText should be a full descriptive sentence.
- Use the object type/name to judge domain-correct terminology.${glossarySection}

Return ONLY a JSON object:
{ "reviews": [{ "id": "...", "quality": "good"|"warning"|"error", "reason": "...", "suggestion": "..." }] }`;

    const userPreamble = `Review these translations:\n`;
    const payload = request.units.map((u) => ({
      id: u.id, source: u.source, target: u.target, ...(u.context ? { context: u.context } : {}),
    }));

    const subBatches = await this.splitByTokenBudget(lm, systemPrompt, userPreamble, payload);
    const results: AIReviewResult[] = [];
    for (const items of subBatches) {
      const content = await this.chat(lm, systemPrompt, userPreamble + JSON.stringify(items));
      const parsed = parseJson<{ reviews?: Array<{ id: string; quality: string; reason?: string; suggestion?: string }> }>(content);
      for (const r of parsed.reviews ?? []) {
        results.push({
          id: r.id,
          quality: (r.quality as AIReviewQuality) || 'warning',
          reason: r.reason,
          suggestion: r.suggestion,
        });
      }
    }

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

  /**
   * Split a JSON payload of items into sub-batches that each fit under the model's
   * input token limit. Reserves headroom for the system prompt, the user preamble,
   * and the model's response. Uses the model's own token counter so it's accurate
   * per-model. An item larger than the whole budget is still emitted on its own so
   * it can surface a precise error instead of silently dropping work.
   */
  private async splitByTokenBudget(
    lm: vscode.LanguageModelChat,
    systemPrompt: string,
    userPreamble: string,
    items: Array<Record<string, unknown>>
  ): Promise<Array<Array<Record<string, unknown>>>> {
    if (items.length === 0) return [];

    const maxInput = lm.maxInputTokens && lm.maxInputTokens > 0 ? lm.maxInputTokens : 8000;
    // Reserve ~35% (capped) for the model's reply plus JSON/array overhead.
    const responseReserve = Math.min(Math.floor(maxInput * 0.35), 4000);
    const fixed = await lm.countTokens(`${systemPrompt}\n\n${userPreamble}[]`);
    const budget = Math.max(maxInput - fixed - responseReserve, 500);

    const batches: Array<Array<Record<string, unknown>>> = [];
    let current: Array<Record<string, unknown>> = [];
    let currentTokens = 0;

    for (const item of items) {
      const itemTokens = await lm.countTokens(JSON.stringify(item));
      // +1 token slack for the joining comma between array items.
      if (current.length > 0 && currentTokens + itemTokens + 1 > budget) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(item);
      currentTokens += itemTokens + 1;
    }
    if (current.length > 0) batches.push(current);
    return batches;
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
