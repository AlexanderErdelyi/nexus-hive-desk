'use client';

import { useState } from 'react';

// ── Model catalogue ────────────────────────────────────────────────────────────

export const MODEL_PROVIDERS = [
  { value: 'github-models', label: 'GitHub Models' },
  { value: 'openai',        label: 'OpenAI' },
  { value: 'azure-openai',  label: 'Azure OpenAI' },
  { value: 'ollama',        label: 'Ollama (local)' },
  { value: 'anthropic',     label: 'Anthropic' },
  { value: 'copilot',       label: 'GitHub Copilot' },
] as const;

const MODELS_BY_PROVIDER: Record<string, Array<{ value: string; label: string }>> = {
  'github-models': [
    { value: 'gpt-4o',                              label: 'GPT-4o' },
    { value: 'gpt-4o-mini',                         label: 'GPT-4o mini' },
    { value: 'gpt-4.1',                             label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini',                        label: 'GPT-4.1 mini' },
    { value: 'gpt-4.1-nano',                        label: 'GPT-4.1 nano' },
    { value: 'o1',                                  label: 'o1' },
    { value: 'o1-mini',                             label: 'o1-mini' },
    { value: 'o3',                                  label: 'o3' },
    { value: 'o3-mini',                             label: 'o3-mini' },
    { value: 'o4-mini',                             label: 'o4-mini' },
    { value: 'claude-3-5-sonnet',                   label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-7-sonnet',                   label: 'Claude 3.7 Sonnet' },
    { value: 'meta-llama-3.1-70b-instruct',         label: 'Llama 3.1 70B' },
    { value: 'meta-llama-3.1-405b-instruct',        label: 'Llama 3.1 405B' },
    { value: 'mistral-large-2407',                  label: 'Mistral Large' },
    { value: 'mistral-small',                       label: 'Mistral Small' },
    { value: 'phi-4',                               label: 'Phi-4' },
    { value: 'phi-4-mini',                          label: 'Phi-4 mini' },
  ],
  openai: [
    { value: 'gpt-4o',          label: 'GPT-4o' },
    { value: 'gpt-4o-mini',     label: 'GPT-4o mini' },
    { value: 'gpt-4-turbo',     label: 'GPT-4 Turbo' },
    { value: 'gpt-4',           label: 'GPT-4' },
    { value: 'gpt-3.5-turbo',   label: 'GPT-3.5 Turbo' },
    { value: 'o1',              label: 'o1' },
    { value: 'o1-mini',         label: 'o1-mini' },
    { value: 'o3',              label: 'o3' },
    { value: 'o3-mini',         label: 'o3-mini' },
    { value: 'o4-mini',         label: 'o4-mini' },
  ],
  'azure-openai': [
    { value: 'gpt-4o',        label: 'GPT-4o' },
    { value: 'gpt-4o-mini',   label: 'GPT-4o mini' },
    { value: 'gpt-4',         label: 'GPT-4' },
    { value: 'gpt-4-turbo',   label: 'GPT-4 Turbo' },
    { value: 'gpt-35-turbo',  label: 'GPT-3.5 Turbo' },
    { value: 'o1',            label: 'o1' },
    { value: 'o1-mini',       label: 'o1-mini' },
  ],
  anthropic: [
    { value: 'claude-opus-4',             label: 'Claude Opus 4' },
    { value: 'claude-sonnet-4',           label: 'Claude Sonnet 4' },
    { value: 'claude-haiku-4',            label: 'Claude Haiku 4' },
    { value: 'claude-3-5-sonnet-latest',  label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-5-haiku-latest',   label: 'Claude 3.5 Haiku' },
    { value: 'claude-3-opus-latest',      label: 'Claude 3 Opus' },
  ],
  copilot: [
    { value: 'claude-sonnet-4.5 (copilot)',  label: 'Claude Sonnet 4.5 (Copilot)' },
    { value: 'claude-opus-4.5 (copilot)',    label: 'Claude Opus 4.5 (Copilot)' },
    { value: 'gpt-4o (copilot)',             label: 'GPT-4o (Copilot)' },
    { value: 'o3 (copilot)',                 label: 'o3 (Copilot)' },
    { value: 'o4-mini (copilot)',            label: 'o4-mini (Copilot)' },
  ],
  ollama: [
    { value: 'llama3',        label: 'Llama 3' },
    { value: 'llama3:70b',    label: 'Llama 3 70B' },
    { value: 'mistral',       label: 'Mistral 7B' },
    { value: 'mixtral',       label: 'Mixtral 8x7B' },
    { value: 'phi3',          label: 'Phi-3' },
    { value: 'gemma2',        label: 'Gemma 2' },
    { value: 'deepseek-r1',   label: 'DeepSeek R1' },
    { value: 'codellama',     label: 'Code Llama' },
  ],
};

const CUSTOM_VALUE = '__custom__';

// ── Component ──────────────────────────────────────────────────────────────────

interface ModelSelectorProps {
  provider: string;
  model: string;
  inputClass: string;
  labelClass: string;
  onProviderChange: (provider: string) => void;
  onModelChange: (model: string) => void;
}

export function ModelSelector({ provider, model, inputClass, labelClass, onProviderChange, onModelChange }: ModelSelectorProps) {
  const models = MODELS_BY_PROVIDER[provider] ?? [];
  const isKnown = models.some((m) => m.value === model);
  const [showCustom, setShowCustom] = useState(!isKnown && model !== '');

  function handleProviderChange(newProvider: string) {
    onProviderChange(newProvider);
    const newModels = MODELS_BY_PROVIDER[newProvider] ?? [];
    if (newModels.length > 0) {
      onModelChange(newModels[0].value);
      setShowCustom(false);
    } else {
      onModelChange('');
    }
  }

  function handleModelSelect(val: string) {
    if (val === CUSTOM_VALUE) {
      setShowCustom(true);
      onModelChange('');
    } else {
      setShowCustom(false);
      onModelChange(val);
    }
  }

  const selectValue = showCustom ? CUSTOM_VALUE : (isKnown ? model : (models.length > 0 ? models[0].value : CUSTOM_VALUE));

  return (
    <>
      {/* Provider */}
      <div>
        <label className={labelClass}>Model Provider</label>
        <select
          className={inputClass}
          value={provider}
          onChange={(e) => handleProviderChange(e.target.value)}
        >
          {MODEL_PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>

      {/* Model */}
      <div>
        <label className={labelClass}>Model</label>
        {models.length > 0 ? (
          <div className="space-y-1.5">
            <select
              className={inputClass}
              value={selectValue}
              onChange={(e) => handleModelSelect(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
              <option value={CUSTOM_VALUE}>— Custom / Other —</option>
            </select>
            {showCustom && (
              <input
                className={inputClass}
                value={model}
                onChange={(e) => onModelChange(e.target.value)}
                placeholder="Enter model name exactly..."
                autoFocus
              />
            )}
          </div>
        ) : (
          <input
            className={inputClass}
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder="e.g. llama3, mistral..."
          />
        )}
      </div>
    </>
  );
}
