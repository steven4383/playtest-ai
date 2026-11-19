import { config, DEFAULT_GEMINI_MODEL } from '../config.js';
import { writeEnv } from '../core/env-file.js';
import { GeminiProvider } from './gemini.js';
import type { LlmProvider } from './provider.js';

export * from './provider.js';

const gemini = new GeminiProvider(config.GEMINI_API_KEY, config.GEMINI_MODEL);
const providers: Record<string, LlmProvider> = { gemini };

/** The active provider (LLM_PROVIDER in .env). Callers never import a vendor class directly. */
export function llm(): LlmProvider {
  return providers[config.LLM_PROVIDER];
}

export function llmStatus() {
  const p = llm();
  return {
    provider: p.id,
    provider_label: p.label,
    model: p.model,
    default_model: DEFAULT_GEMINI_MODEL,
    configured: p.configured(),
    key_hint: p === gemini ? gemini.keyHint() : null,
    get_key_url: 'https://aistudio.google.com/apikey',
  };
}

const KEY_RE = /^[\w.-]{20,200}$/; // classic AIza… keys and newer AQ.… keys
const MODEL_RE = /^[\w.-]{1,100}$/;

/** Update the Gemini key / model at runtime and persist them to backend/.env. */
export function configureGemini(input: { api_key?: string | null; model?: string }) {
  const updates: Record<string, string> = {};
  if (input.api_key !== undefined) {
    const key = (input.api_key ?? '').trim();
    if (key && !KEY_RE.test(key)) throw Object.assign(new Error('That does not look like a Gemini API key (expected letters, digits and - _ . only, e.g. AIza… or AQ.…)'), { statusCode: 400 });
    gemini.setKey(key);
    updates.GEMINI_API_KEY = key;
  }
  if (input.model !== undefined) {
    const model = input.model.trim().replace(/^models\//, '') || DEFAULT_GEMINI_MODEL;
    if (!MODEL_RE.test(model)) throw Object.assign(new Error('Invalid model id'), { statusCode: 400 });
    gemini.model = model;
    updates.GEMINI_MODEL = model;
  }
  if (Object.keys(updates).length) writeEnv(updates);
  return llmStatus();
}
