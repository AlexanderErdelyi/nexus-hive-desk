import type {
  AIProviderType,
  AIReviewRequest,
  AIReviewResponse,
  AIReviewResult,
  AIReviewQuality,
  AIReviewUnit,
  AITranslateRequest,
  AITranslateResponse,
  AITranslateResult,
  AIGlossaryGenerateRequest,
  AIGlossaryPromptRequest,
  AIGlossaryResponse,
  AIGlossarySuggestion,
} from '@nexus/types';

export interface AIProvider {
  type: AIProviderType;
  model: string;
  translate(request: AITranslateRequest): Promise<AITranslateResponse>;
  review(request: AIReviewRequest): Promise<AIReviewResponse>;
  generateGlossary(request: AIGlossaryGenerateRequest): Promise<AIGlossaryResponse>;
  suggestGlossaryFromPrompt(request: AIGlossaryPromptRequest): Promise<AIGlossaryResponse>;
}

function buildPrompts(request: AITranslateRequest) {
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
- "confidence" is a number 0–100 indicating your certainty:
  - 90–100: certain (simple word, glossary match, or very clear translation)
  - 70–89: likely correct (standard phrase)
  - 50–69: uncertain (ambiguous or domain-specific)
  - below 50: low confidence (needs manual review)${glossarySection}`;

  const userPrompt = `Translate these strings:\n${JSON.stringify(
    request.units.map((u) => ({ id: u.id, text: u.source }))
  )}`;

  return { systemPrompt, userPrompt };
}

async function translateWithEndpoint(options: {
  baseURL: string;
  apiKey: string;
  model: string;
  request: AITranslateRequest;
}) {
  const { systemPrompt, userPrompt } = buildPrompts(options.request);
  const response = await fetch(`${options.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AI provider error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content ?? '{}';
  let parsed: { translations?: Array<{ id: string; translation: string; confidence?: number }> };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Failed to parse AI response: ${content}`);
  }

  const translations = parsed.translations ?? [];
  const results: AITranslateResult[] = translations.map((translation) => {
    const score = typeof translation.confidence === 'number' ? translation.confidence : 85;
    const tier: 'high' | 'medium' | 'low' = score >= 90 ? 'high' : score >= 70 ? 'medium' : 'low';
    return {
      id: translation.id,
      translatedText: translation.translation,
      confidence: tier,
      confidenceScore: score,
    };
  });

  return results;
}

async function reviewWithEndpoint(options: {
  baseURL: string;
  apiKey: string;
  model: string;
  request: AIReviewRequest;
}): Promise<AIReviewResult[]> {
  const { request } = options;

  const glossarySection =
    request.glossary && request.glossary.length > 0
      ? `\n\nGlossary (these terms MUST be translated exactly as specified):\n${request.glossary
          .map((g) => `  "${g.sourceTerm}" → "${g.targetTerm}"`)
          .join('\n')}`
      : '';

  const additionalSection = request.additionalContext
    ? `\n\nAdditional reviewer instructions:\n${request.additionalContext}`
    : '';

  const systemPrompt = `You are an expert Business Central (Microsoft Dynamics 365 BC) localization quality reviewer.
Review ${request.sourceLanguage} → ${request.targetLanguage} UI string translations.

For each string evaluate:
1. Semantic correctness — does the translation convey the same meaning?
2. BC/ERP terminology — are business terms correct (e.g. Vendor/Kreditor, Customer/Debitor, Journal/Buchungsblatt)?
3. Placeholder preservation — are %1, %2, {0}, &shortcuts exactly preserved?
4. UI appropriateness — is the translation concise and professional for a business app?
5. Grammar and spelling correctness in the target language${glossarySection}${additionalSection}

Return ONLY a JSON object:
{
  "reviews": [
    {
      "id": "<exact string id from input>",
      "quality": "good" | "warning" | "error",
      "reason": "<one-sentence reason if not good, null otherwise>",
      "suggestion": "<improved translation if applicable, null if good>"
    }
  ]
}`;

  const userPrompt = `Review these translations:\n${JSON.stringify(
    request.units.map((u) => ({
      id: u.id,
      source: u.source,
      target: u.target,
      ...(u.context ? { context: u.context } : {}),
    }))
  )}`;

  const response = await fetch(`${options.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AI provider error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content ?? '{}';
  let parsed: { reviews?: Array<{ id: string; quality: string; reason?: string; suggestion?: string }> };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Failed to parse AI review response: ${content}`);
  }

  return (parsed.reviews ?? []).map((r) => ({
    id: r.id,
    quality: (r.quality as AIReviewQuality) || 'warning',
    reason: r.reason ?? undefined,
    suggestion: r.suggestion ?? undefined,
  }));
}

async function generateGlossaryWithEndpoint(options: {
  baseURL: string;
  apiKey: string;
  model: string;
  request: AIGlossaryGenerateRequest;
}): Promise<AIGlossarySuggestion[]> {
  const { request } = options;
  const skipSection = request.existingTerms?.length
    ? `\n\nAlready in glossary (DO NOT suggest these again): ${request.existingTerms.join(', ')}`
    : '';

  const systemPrompt = `You are a Business Central (Microsoft Dynamics 365 BC) localization expert.
Analyze ${request.sourceLanguage} → ${request.targetLanguage} translation pairs and identify important BC-specific terms that should be in a fixed glossary.

Focus on:
- ERP/BC terminology (Customer/Debitor, Vendor/Kreditor, Journal/Buchungsblatt, Item/Artikel, Ledger/Sachkonto, etc.)
- Terms where the literal translation is wrong in BC context
- Recurring business terms that must be consistent across the app
- Field names, object types, module names specific to BC${skipSection}

Return ONLY a JSON object:
{
  "suggestions": [
    {
      "sourceTerm": "<English term>",
      "targetTerm": "<correct ${request.targetLanguage} BC term>",
      "description": "<one sentence: why this specific term is used in BC>",
      "confidence": "high" | "medium" | "low"
    }
  ]
}
Return 10-30 of the most important terms. Prefer high-confidence BC-specific ones.`;

  const userPrompt = `Analyze these translation samples and extract glossary terms:\n${JSON.stringify(
    request.samples.slice(0, 150).map((s) => ({
      source: s.source,
      target: s.target,
      ...(s.context ? { context: s.context } : {}),
    }))
  )}`;

  const response = await fetch(`${options.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) throw new Error(`AI provider error ${response.status}: ${await response.text()}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? '{}';
  let parsed: { suggestions?: AIGlossarySuggestion[] };
  try { parsed = JSON.parse(content); } catch { throw new Error(`Failed to parse AI glossary response: ${content}`); }
  return parsed.suggestions ?? [];
}

async function suggestGlossaryFromPromptWithEndpoint(options: {
  baseURL: string;
  apiKey: string;
  model: string;
  request: AIGlossaryPromptRequest;
}): Promise<AIGlossarySuggestion[]> {
  const { request } = options;
  const skipSection = request.existingTerms?.length
    ? `\n\nAlready in glossary (DO NOT suggest these): ${request.existingTerms.join(', ')}`
    : '';

  const systemPrompt = `You are a Business Central (Microsoft Dynamics 365 BC) localization expert.
Generate ${request.sourceLanguage} → ${request.targetLanguage} glossary entries based on user instructions.
Output correct BC/ERP terminology — not literal/dictionary translations.${skipSection}

Return ONLY a JSON object:
{
  "suggestions": [
    {
      "sourceTerm": "<English term>",
      "targetTerm": "<correct ${request.targetLanguage} BC term>",
      "description": "<one sentence explaining BC usage>",
      "confidence": "high" | "medium" | "low"
    }
  ]
}`;

  const userPrompt = `Generate glossary entries for:\n${request.prompt}`;

  const response = await fetch(`${options.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) throw new Error(`AI provider error ${response.status}: ${await response.text()}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? '{}';
  let parsed: { suggestions?: AIGlossarySuggestion[] };
  try { parsed = JSON.parse(content); } catch { throw new Error(`Failed to parse AI glossary prompt response: ${content}`); }
  return parsed.suggestions ?? [];
}

// ─── GitHub Models Provider ───────────────────────────────────────────────────
export class GitHubModelsProvider implements AIProvider {
  readonly type: AIProviderType = 'github-models';
  readonly model: string;
  private readonly token: string;
  private readonly baseURL = 'https://models.inference.ai.azure.com';

  constructor(opts: { token: string; model?: string }) {
    this.token = opts.token;
    this.model = opts.model ?? 'gpt-4o-mini';
  }

  async translate(request: AITranslateRequest): Promise<AITranslateResponse> {
    const results = await translateWithEndpoint({
      baseURL: this.baseURL,
      apiKey: this.token,
      model: this.model,
      request,
    });

    return { results, provider: this.type, model: this.model };
  }

  async review(request: AIReviewRequest): Promise<AIReviewResponse> {
    const results = await reviewWithEndpoint({
      baseURL: this.baseURL,
      apiKey: this.token,
      model: this.model,
      request,
    });

    return { results, provider: this.type, model: this.model };
  }

  async generateGlossary(request: AIGlossaryGenerateRequest): Promise<AIGlossaryResponse> {
    const suggestions = await generateGlossaryWithEndpoint({ baseURL: this.baseURL, apiKey: this.token, model: this.model, request });
    return { suggestions, provider: this.type, model: this.model };
  }

  async suggestGlossaryFromPrompt(request: AIGlossaryPromptRequest): Promise<AIGlossaryResponse> {
    const suggestions = await suggestGlossaryFromPromptWithEndpoint({ baseURL: this.baseURL, apiKey: this.token, model: this.model, request });
    return { suggestions, provider: this.type, model: this.model };
  }
}

// ─── OpenAI-compatible provider (Azure OpenAI, etc.) ─────────────────────────
export class OpenAICompatibleProvider implements AIProvider {
  readonly type: AIProviderType;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(opts: {
    type: AIProviderType;
    apiKey: string;
    baseURL: string;
    model?: string;
  }) {
    this.type = opts.type;
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL;
    this.model = opts.model ?? 'gpt-4o';
  }

  async translate(request: AITranslateRequest): Promise<AITranslateResponse> {
    const results = await translateWithEndpoint({
      baseURL: this.baseURL,
      apiKey: this.apiKey,
      model: this.model,
      request,
    });

    return { results, provider: this.type, model: this.model };
  }

  async review(request: AIReviewRequest): Promise<AIReviewResponse> {
    const results = await reviewWithEndpoint({
      baseURL: this.baseURL,
      apiKey: this.apiKey,
      model: this.model,
      request,
    });

    return { results, provider: this.type, model: this.model };
  }

  async generateGlossary(request: AIGlossaryGenerateRequest): Promise<AIGlossaryResponse> {
    const suggestions = await generateGlossaryWithEndpoint({ baseURL: this.baseURL, apiKey: this.apiKey, model: this.model, request });
    return { suggestions, provider: this.type, model: this.model };
  }

  async suggestGlossaryFromPrompt(request: AIGlossaryPromptRequest): Promise<AIGlossaryResponse> {
    const suggestions = await suggestGlossaryFromPromptWithEndpoint({ baseURL: this.baseURL, apiKey: this.apiKey, model: this.model, request });
    return { suggestions, provider: this.type, model: this.model };
  }
}

// ─── Provider factory ─────────────────────────────────────────────────────────
export function createProvider(config: {
  type: AIProviderType;
  token: string;
  model?: string;
  baseURL?: string;
}): AIProvider {
  switch (config.type) {
    case 'github-models':
      return new GitHubModelsProvider({ token: config.token, model: config.model });
    case 'openai':
    case 'azure-openai':
      return new OpenAICompatibleProvider({
        type: config.type,
        apiKey: config.token,
        baseURL: config.baseURL ?? 'https://api.openai.com/v1',
        model: config.model,
      });
    default:
      throw new Error(`Unknown AI provider: ${config.type}`);
  }
}

export type { AIProviderType, AIReviewQuality, AIReviewRequest, AIReviewResponse, AIReviewResult, AIReviewUnit, AITranslateRequest, AITranslateResponse, AITranslateResult };
