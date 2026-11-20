import type { FastifyInstance } from '../http';
import { z } from 'zod';
import { configureGemini, llm, LlmError, llmStatus } from '../llm/index';

const configBody = z.object({
  api_key: z.string().max(200).nullable().optional(),
  model: z.string().max(100).optional(),
});

const testBody = z.object({
  prompt: z.string().min(1).max(4000).optional(),
});

export async function llmRoutes(app: FastifyInstance) {
  const fail = (reply: any, err: unknown) => {
    if (err instanceof LlmError) return reply.code(err.statusCode).send({ error: err.message, kind: err.kind });
    throw err;
  };

  /** Never returns the key itself — only whether one is set and its last 4 characters. */
  app.get('/llm/status', async () => llmStatus());

  app.put('/llm/config', async (req) => configureGemini(configBody.parse(req.body ?? {})));

  app.get('/llm/models', async (_req, reply) => {
    try {
      return { models: await llm().listModels() };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Round-trip check that the key + model work. */
  app.post('/llm/test', async (req, reply) => {
    const { prompt } = testBody.parse(req.body ?? {});
    try {
      return await llm().generate({
        system: 'You are the AI engine of PlayTest AI, an Android app QA tool. Be concise.',
        prompt: prompt ?? 'Reply with one short sentence confirming you are ready to help test Android apps.',
        timeoutMs: 45_000,
      });
    } catch (err) {
      return fail(reply, err);
    }
  });
}
