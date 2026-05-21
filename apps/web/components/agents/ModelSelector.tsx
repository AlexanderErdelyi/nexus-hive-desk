'use client';

import { useState } from 'react';

// ── Known model values (for custom-input detection) ────────────────────────────

const KNOWN_MODELS = new Set([
  'openai/gpt-4o-mini', 'openai/gpt-4o', 'openai/gpt-4.1-nano', 'openai/gpt-4.1-mini', 'openai/gpt-4.1',
  'openai/gpt-5-nano', 'openai/gpt-5-mini', 'openai/gpt-5',
  'openai/o4-mini', 'openai/o3-mini', 'openai/o3',
  'meta/llama-4-scout-17b-16e-instruct', 'meta/llama-4-maverick-17b-128e-instruct-fp8', 'meta/llama-3.3-70b-instruct',
  'deepseek/deepseek-r1-0528', 'deepseek/deepseek-v3-0324',
  'microsoft/phi-4', 'microsoft/phi-4-mini-instruct',
  'ai21-labs/ai21-jamba-1.5-large', 'cohere/cohere-command-a',
  'claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5',
  'claude-sonnet-4.5 (copilot)', 'claude-opus-4.5 (copilot)', 'gpt-4o (copilot)', 'o3 (copilot)', 'o4-mini (copilot)',
  'llama3', 'llama3:70b', 'mistral', 'mixtral', 'phi3', 'gemma2', 'deepseek-r1', 'codellama',
]);

function deriveProvider(model: string): string {
  if (model.includes('(copilot)')) return 'copilot';
  if (model.startsWith('openai/') || model.startsWith('gpt-') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('meta/')) return 'meta';
  if (model.startsWith('deepseek/')) return 'deepseek';
  if (model.startsWith('microsoft/')) return 'microsoft';
  if (model === 'llama3' || model === 'llama3:70b' || model === 'mistral' || model === 'mixtral' || model === 'phi3' || model === 'gemma2' || model === 'deepseek-r1' || model === 'codellama') return 'ollama';
  return 'openai';
}

const CUSTOM_VALUE = '__custom__';

// ── Component ──────────────────────────────────────────────────────────────────

interface ModelSelectorProps {
  model: string;
  inputClass: string;
  labelClass: string;
  onModelChange: (model: string, provider: string) => void;
}

export function ModelSelector({ model, inputClass, labelClass, onModelChange }: ModelSelectorProps) {
  const isKnown = KNOWN_MODELS.has(model);
  const [showCustom, setShowCustom] = useState(!isKnown && model !== '');

  const selectValue = showCustom ? CUSTOM_VALUE : (isKnown ? model : '');

  function handleSelect(val: string) {
    if (val === CUSTOM_VALUE) {
      setShowCustom(true);
      onModelChange('', '');
    } else {
      setShowCustom(false);
      onModelChange(val, deriveProvider(val));
    }
  }

  return (
    <div className="sm:col-span-2">
      <label className={labelClass}>Model</label>
      <div className="space-y-1.5">
        <select className={inputClass} value={selectValue} onChange={(e) => handleSelect(e.target.value)}>
          <option value="">Default (openai/gpt-4o-mini)</option>

          <optgroup label="── OpenAI GPT-4.x — General purpose ──">
            <option value="openai/gpt-4o-mini">gpt-4o-mini · fast, cheap · good for drafts</option>
            <option value="openai/gpt-4o">gpt-4o · balanced, multimodal</option>
            <option value="openai/gpt-4.1-nano">gpt-4.1-nano · fastest GPT-4.1, lowest cost</option>
            <option value="openai/gpt-4.1-mini">gpt-4.1-mini · fast + capable, better than 4o-mini</option>
            <option value="openai/gpt-4.1">gpt-4.1 · best overall · ideal for documentation</option>
          </optgroup>

          <optgroup label="── OpenAI GPT-5 — Latest generation ──">
            <option value="openai/gpt-5-nano">gpt-5-nano · ultra-fast, low latency</option>
            <option value="openai/gpt-5-mini">gpt-5-mini · lightweight gpt-5, cost-efficient</option>
            <option value="openai/gpt-5">gpt-5 · most capable ⚡</option>
          </optgroup>

          <optgroup label="── OpenAI o-series — Reasoning ⚡ ──">
            <option value="openai/o4-mini">o4-mini · fast reasoning, great for structured output</option>
            <option value="openai/o3-mini">o3-mini · efficient reasoning</option>
            <option value="openai/o3">o3 · advanced reasoning + safety</option>
          </optgroup>

          <optgroup label="── Meta Llama 4 — Open source ──">
            <option value="meta/llama-4-scout-17b-16e-instruct">Llama 4 Scout · 10M context · multi-doc summarization</option>
            <option value="meta/llama-4-maverick-17b-128e-instruct-fp8">Llama 4 Maverick · creative writing, quality</option>
            <option value="meta/llama-3.3-70b-instruct">Llama 3.3 70B · strong multilingual reasoning</option>
          </optgroup>

          <optgroup label="── DeepSeek — Coding + Reasoning ──">
            <option value="deepseek/deepseek-r1-0528">DeepSeek-R1-0528 · best reasoning, code, BC logic</option>
            <option value="deepseek/deepseek-v3-0324">DeepSeek-V3 · coding, agents, function calling</option>
          </optgroup>

          <optgroup label="── Microsoft Phi-4 — Efficient ──">
            <option value="microsoft/phi-4">Phi-4 · 14B, highly capable, low latency</option>
            <option value="microsoft/phi-4-mini-instruct">Phi-4-mini · ultra-efficient, math + coding</option>
          </optgroup>

          <optgroup label="── Other ──">
            <option value="ai21-labs/ai21-jamba-1.5-large">Jamba 1.5 Large · 256K context · multilingual RAG</option>
            <option value="cohere/cohere-command-a">Cohere Command A · RAG, multilingual agents</option>
          </optgroup>

          <optgroup label="── Anthropic Claude (needs ANTHROPIC_API_KEY) ──">
            <option value="claude-haiku-4-5">claude-haiku-4-5 · fastest Claude, cheap drafts</option>
            <option value="claude-sonnet-4-5">claude-sonnet-4-5 · balanced, excellent writing</option>
            <option value="claude-opus-4-5">claude-opus-4-5 · most capable Claude</option>
          </optgroup>

          <optgroup label="── GitHub Copilot ──">
            <option value="claude-sonnet-4.5 (copilot)">Claude Sonnet 4.5 (Copilot)</option>
            <option value="claude-opus-4.5 (copilot)">Claude Opus 4.5 (Copilot)</option>
            <option value="gpt-4o (copilot)">GPT-4o (Copilot)</option>
            <option value="o3 (copilot)">o3 (Copilot)</option>
            <option value="o4-mini (copilot)">o4-mini (Copilot)</option>
          </optgroup>

          <optgroup label="── Ollama (local) ──">
            <option value="llama3">llama3</option>
            <option value="llama3:70b">llama3:70b</option>
            <option value="mistral">mistral</option>
            <option value="mixtral">mixtral</option>
            <option value="phi3">phi3</option>
            <option value="gemma2">gemma2</option>
            <option value="deepseek-r1">deepseek-r1</option>
            <option value="codellama">codellama</option>
          </optgroup>

          <option value={CUSTOM_VALUE}>✏ Custom model ID…</option>
        </select>

        {showCustom && (
          <input
            className={inputClass}
            value={model}
            onChange={(e) => onModelChange(e.target.value, deriveProvider(e.target.value))}
            placeholder="Enter model ID exactly, e.g. openai/gpt-4o"
            autoFocus
          />
        )}
      </div>
    </div>
  );
}
