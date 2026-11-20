/** Provider-agnostic LLM contract. Test generation / bug triage code talks to this, never to a vendor SDK. */

export interface GenerateOptions {
  prompt: string;
  system?: string;
  /** Ask the model for a JSON object (response is still returned as text). */
  json?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface GenerateResult {
  text: string;
  model: string;
  finish_reason: string | null;
  usage: { input_tokens: number | null; output_tokens: number | null };
  latency_ms: number;
}

export interface ModelInfo {
  id: string;
  display_name: string;
  input_token_limit: number | null;
  output_token_limit: number | null;
}

export interface LlmProvider {
  readonly id: string;
  readonly label: string;
  model: string;
  configured(): boolean;
  generate(opts: GenerateOptions): Promise<GenerateResult>;
  listModels(): Promise<ModelInfo[]>;
}

export type LlmErrorKind = 'not_configured' | 'auth' | 'rate_limit' | 'model' | 'bad_request' | 'upstream' | 'network' | 'blocked';

export class LlmError extends Error {
  constructor(
    message: string,
    public kind: LlmErrorKind,
    public statusCode = 502,
  ) {
    super(message);
  }
}
