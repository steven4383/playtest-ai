import { LlmError, type GenerateOptions, type GenerateResult, type LlmProvider, type ModelInfo } from './provider.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Google Gemini via the REST API (free tier key from https://aistudio.google.com/apikey).
 * The key is sent in the x-goog-api-key header, never in the URL, so it does not end up in logs.
 */
export class GeminiProvider implements LlmProvider {
  readonly id = 'gemini';
  readonly label = 'Google Gemini';

  constructor(
    private apiKey: string,
    public model: string,
  ) {}

  configured() {
    return this.apiKey.length > 0;
  }

  setKey(key: string) {
    this.apiKey = key;
  }

  keyHint(): string | null {
    return this.apiKey ? `…${this.apiKey.slice(-4)}` : null;
  }

  private async request(pathAndQuery: string, init: RequestInit & { timeoutMs?: number } = {}) {
    if (!this.configured())
      throw new LlmError('Gemini API key is not set — add GEMINI_API_KEY to backend/.env or paste it on the AI page', 'not_configured', 412);
    let res: Response;
    try {
      res = await fetch(`${BASE}${pathAndQuery}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey, ...init.headers },
        signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
      });
    } catch (err: any) {
      const timeout = err?.name === 'TimeoutError';
      throw new LlmError(timeout ? 'Gemini request timed out' : `Cannot reach Gemini API: ${err?.cause?.code ?? err?.message}`, 'network', 504);
    }
    const body: any = await res.json().catch(() => ({}));
    if (res.ok) return body;

    const msg: string = body?.error?.message ?? `${res.status} ${res.statusText}`;
    const status: string = body?.error?.status ?? '';
    if (res.status === 429 || status === 'RESOURCE_EXHAUSTED')
      throw new LlmError(`Gemini rate limit / free-tier quota reached — wait a minute and retry. (${msg})`, 'rate_limit', 429);
    if (res.status === 401 || res.status === 403 || /api key not valid|API_KEY_INVALID/i.test(msg))
      throw new LlmError(`Gemini rejected the API key: ${msg}`, 'auth', 401);
    if (res.status === 404)
      throw new LlmError(`Gemini model "${this.model}" not found — pick another from the model list. (${msg})`, 'model', 404);
    if (res.status === 400) throw new LlmError(`Gemini rejected the request: ${msg}`, 'bad_request', 400);
    throw new LlmError(`Gemini error ${res.status}: ${msg}`, 'upstream', 502);
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const started = Date.now();
    const generationConfig: Record<string, unknown> = {};
    if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
    if (opts.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = opts.maxOutputTokens;
    if (opts.json) generationConfig.responseMimeType = 'application/json';

    const body = await this.request(`/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      timeoutMs: opts.timeoutMs,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
        ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      }),
    });

    if (body?.promptFeedback?.blockReason)
      throw new LlmError(`Gemini blocked the prompt (${body.promptFeedback.blockReason})`, 'blocked', 422);
    const cand = body?.candidates?.[0];
    const text = (cand?.content?.parts ?? [])
      .filter((p: any) => typeof p.text === 'string' && !p.thought)
      .map((p: any) => p.text)
      .join('');
    return {
      text,
      model: body?.modelVersion ?? this.model,
      finish_reason: cand?.finishReason ?? null,
      usage: {
        input_tokens: body?.usageMetadata?.promptTokenCount ?? null,
        output_tokens: body?.usageMetadata?.candidatesTokenCount ?? null,
      },
      latency_ms: Date.now() - started,
    };
  }

  /** Models this key can call with generateContent. */
  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    let pageToken = '';
    for (let page = 0; page < 5; page++) {
      const body = await this.request(`/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { timeoutMs: 20_000 });
      for (const m of body?.models ?? []) {
        if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
        out.push({
          id: String(m.name).replace(/^models\//, ''),
          display_name: m.displayName ?? m.name,
          input_token_limit: m.inputTokenLimit ?? null,
          output_token_limit: m.outputTokenLimit ?? null,
        });
      }
      pageToken = body?.nextPageToken ?? '';
      if (!pageToken) break;
    }
    return out;
  }
}
