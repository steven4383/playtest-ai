import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Field, Flex, Input, Link, List, NativeSelect, SimpleGrid, Spinner, Stack, Text } from '@chakra-ui/react';
import { LuBot, LuExternalLink, LuKeyRound, LuSend, LuSparkles } from 'react-icons/lu';
import { api, type LlmModel, type LlmStatus, type LlmTestResult } from '../lib/api';
import { Badge, Card, Loading, Spinning } from '../components/ui';
import { notify } from '../components/toaster';

/** Gemini API key + model settings, with a round-trip test. The key never comes back from the backend. */
export function AiPage() {
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [models, setModels] = useState<LlmModel[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<LlmTestResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const r = await api<{ models: LlmModel[] }>('/llm/models');
      setModels(r.models.filter((m) => /gemini/i.test(m.id)));
    } catch (e: any) {
      setModels(null);
      notify('error', e.message);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    api<LlmStatus>('/llm/status')
      .then((s) => {
        setStatus(s);
        setModel(s.model);
        if (s.configured) void loadModels();
      })
      .catch((e) => setLoadError(e.message));
  }, [loadModels]);

  const run = async (k: string, fn: () => Promise<void>) => {
    setBusy(k);
    try {
      await fn();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };

  const saveKey = (e: React.FormEvent) => {
    e.preventDefault();
    void run('key', async () => {
      const s = await api<LlmStatus>('/llm/config', { method: 'PUT', body: JSON.stringify({ api_key: key.trim() }) });
      setStatus(s);
      setKey('');
      notify('ok', `Key saved to backend/.env (${s.key_hint}). Press “Send test prompt” to check it works.`);
      await loadModels();
    });
  };

  const removeKey = () => {
    if (!confirm('Remove the Gemini API key from backend/.env?')) return;
    void run('remove', async () => {
      setStatus(await api<LlmStatus>('/llm/config', { method: 'PUT', body: JSON.stringify({ api_key: '' }) }));
      setModels(null);
      setResult(null);
      notify('ok', 'Key removed.');
    });
  };

  const saveModel = (id: string) =>
    run('model', async () => {
      setModel(id);
      setStatus(await api<LlmStatus>('/llm/config', { method: 'PUT', body: JSON.stringify({ model: id }) }));
      notify('ok', `Model set to ${id}.`);
    });

  const test = (e: React.FormEvent) => {
    e.preventDefault();
    void run('test', async () => {
      setResult(null);
      setResult(await api<LlmTestResult>('/llm/test', { method: 'POST', body: JSON.stringify(prompt.trim() ? { prompt: prompt.trim() } : {}) }));
    });
  };

  if (!status) return loadError ? <Text color="fg.error">{loadError}</Text> : <Spinning label="Loading AI settings…" />;

  return (
    <SimpleGrid columns={{ base: 1, lg: 2 }} gap="5" alignItems="start">
      <Card
        icon={<LuKeyRound />}
        title={status.provider_label}
        subtitle="Powers test generation and bug triage"
        actions={status.configured ? <Badge tone="good">{`key set ${status.key_hint}`}</Badge> : <Badge tone="warning">no key</Badge>}
      >
        <List.Root as="ol" gap="1.5" ps="5" fontSize="sm">
          <List.Item>
            Open{' '}
            <Link href={status.get_key_url} target="_blank" rel="noreferrer" color="colorPalette.fg">
              Google AI Studio → API keys <LuExternalLink />
            </Link>{' '}
            and sign in with a Google account.
          </List.Item>
          <List.Item>
            Click <b>Create API key</b> (no billing needed for the free tier) and copy it.
          </List.Item>
          <List.Item>Paste it below. It is stored only in backend/.env on this PC and is never shown again.</List.Item>
        </List.Root>
        <form onSubmit={saveKey}>
          <Flex gap="2" align="flex-end" wrap="wrap">
            <Field.Root flex="1" minW="220px">
              <Field.Label>Gemini API key</Field.Label>
              <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={status.configured ? 'Paste a new key to replace' : 'AIza…'} autoComplete="off" spellCheck={false} required />
            </Field.Root>
            <Button type="submit" loading={busy === 'key'} loadingText="Saving" disabled={key.trim().length < 20}>
              Save key
            </Button>
            {status.configured && (
              <Button type="button" variant="ghost" colorPalette="red" disabled={!!busy} loading={busy === 'remove'} onClick={removeKey}>
                Remove
              </Button>
            )}
          </Flex>
        </form>
        <Text fontSize="xs" color="fg.muted">
          Free tier: Flash models only, with per-minute and per-day request limits that Google changes from time to time — PlayTest AI shows a clear message when you hit one. On
          the free tier Google may use prompts to improve its products, so avoid sending confidential app data.
        </Text>
      </Card>

      <Card icon={<LuBot />} title="Model" subtitle={`Default ${status.default_model}`}>
        {modelsLoading ? (
          <Loading rows={1} height="9" label="Loading models" />
        ) : models && models.length > 0 ? (
          <Field.Root>
            <Field.Label>Models your key can use</Field.Label>
            <NativeSelect.Root disabled={busy === 'model'}>
              <NativeSelect.Field value={model} onChange={(e) => void saveModel(e.target.value)}>
                {!models.some((m) => m.id === model) && <option value={model}>{model} (not in list)</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name} — {m.id}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Field.Root>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveModel(model.trim());
            }}
          >
            <Flex gap="2" align="flex-end">
              <Field.Root flex="1">
                <Field.Label>Model id</Field.Label>
                <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={status.default_model} />
              </Field.Root>
              <Button type="submit" variant="outline" loading={busy === 'model'}>
                Save
              </Button>
            </Flex>
          </form>
        )}
        <Text fontSize="xs" color="fg.muted">
          Flash / Flash-Lite models are free. If Google retires a model you get a “model not found” error — pick another one here.
        </Text>

        <form onSubmit={test}>
          <Stack gap="2">
            <Field.Root>
              <Field.Label>Test prompt (optional)</Field.Label>
              <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Suggest 3 test cases for a login screen" maxLength={4000} />
            </Field.Root>
            <Button type="submit" alignSelf="flex-start" disabled={!status.configured} loading={busy === 'test'} loadingText="Waiting for Gemini…">
              <LuSend /> Send test prompt
            </Button>
          </Stack>
        </form>
        {busy === 'test' && (
          <Flex gap="2" align="center" color="fg.muted" fontSize="sm">
            <Spinner size="xs" /> <LuSparkles /> Gemini is thinking…
          </Flex>
        )}
        {result && (
          <Box>
            <Box as="pre" whiteSpace="pre-wrap" fontFamily="body" fontSize="sm" bg="bg.subtle" borderWidth="1px" borderRadius="md" p="3" maxH="80" overflowY="auto">
              {result.text || '(empty response)'}
            </Box>
            <Text fontSize="xs" color="fg.muted" mt="1">
              {result.model} · {(result.latency_ms / 1000).toFixed(1)} s · {result.usage.input_tokens ?? '?'} in / {result.usage.output_tokens ?? '?'} out tokens
              {result.finish_reason && result.finish_reason !== 'STOP' && ` · finish: ${result.finish_reason}`}
            </Text>
          </Box>
        )}
      </Card>
    </SimpleGrid>
  );
}
