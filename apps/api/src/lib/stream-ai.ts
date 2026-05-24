/**
 * Shared AI streaming helpers — used by work-items, skills and agents test-run endpoints.
 */

export interface ChatModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function readOpenAIStream(
  body: ReadableStream<Uint8Array>,
  onToken: (chunk: string) => void
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') continue;
      try {
        const parsed = JSON.parse(raw) as { choices?: Array<{ delta?: { content?: string } }> };
        const chunk = parsed.choices?.[0]?.delta?.content ?? '';
        if (chunk) { fullText += chunk; onToken(chunk); }
      } catch { /* skip malformed chunks */ }
    }
  }
  return fullText;
}

export async function fetchModelStream(
  token: string,
  model: string,
  messages: ChatModelMessage[],
  onToken: (chunk: string) => void,
  temperature = 0.7
): Promise<string> {
  // Anthropic Claude SSE (direct or via OpenRouter)
  if (model.startsWith('claude-')) {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    if (anthropicKey) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: 4096, stream: true,
          system: messages[0]?.role === 'system' ? messages[0].content : undefined,
          messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API error: ${await res.text().catch(() => res.statusText)}`);
      if (!res.body) throw new Error('No response body from Anthropic');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', fullText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6).trim()) as { type?: string; delta?: { type?: string; text?: string } };
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              const chunk = evt.delta.text ?? '';
              if (chunk) { fullText += chunk; onToken(chunk); }
            }
          } catch { /* skip */ }
        }
      }
      return fullText;
    }

    if (openRouterKey) {
      const orModel = model.startsWith('anthropic/') ? model : `anthropic/${model}`;
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openRouterKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: orModel, messages, temperature, stream: true }),
      });
      if (!res.ok) throw new Error(`OpenRouter API error: ${await res.text().catch(() => res.statusText)}`);
      if (!res.body) throw new Error('No response body from OpenRouter');
      return readOpenAIStream(res.body, onToken);
    }

    throw new Error('Claude model selected but ANTHROPIC_API_KEY or OPENROUTER_API_KEY is not configured');
  }

  // OpenRouter for non-Claude, non-GitHub models (deepseek, meta, etc.)
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey && (model.includes('/') || model.startsWith('deepseek') || model.startsWith('meta'))) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openRouterKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature, stream: true }),
    });
    if (!res.ok) throw new Error(`OpenRouter API error: ${await res.text().catch(() => res.statusText)}`);
    if (!res.body) throw new Error('No response body from OpenRouter');
    return readOpenAIStream(res.body, onToken);
  }

  // Default: GitHub Models (OpenAI-compatible SSE)
  const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature, stream: true }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`AI API error: ${text}`);
  }
  if (!res.body) throw new Error('No response body from AI');
  return readOpenAIStream(res.body, onToken);
}
