/**
 * Pool failover: ordered per-route fallback pools, walked until one serves.
 *
 * @module dsh-inferhub-duo/tests/pool
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmError, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as plugin from '../src/index.ts';
import { STATUS_PATH } from '../src/index.ts';
import type { DuoSettings } from '../src/duo-config.ts';
import { resolveDuoConfig, toInferHubSettings } from '../src/duo-config.ts';
import { PoolFailoverAdapter, poolViolatingPrefixes } from '../src/pool.ts';
import type { PoolInnerAdapter } from '../src/pool.ts';
import type { MinFilterMember } from '../src/duo-config.ts';
import { startMockInferHub, type MockInferHub } from './mock-inferhub.ts';

const KEY_REF = 'INFERHUB_API_KEY_DUO_POOL';

let mock: MockInferHub;
let home = '';
let previousHome: string | undefined;

beforeAll(async () => {
  mock = await startMockInferHub();
  home = await mkdtemp(join(tmpdir(), 'dsh-inferhub-duo-pool-'));
  previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  process.env[KEY_REF] = 'sk-airo-duo-pool';
});

afterAll(async () => {
  await mock.close();
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  delete process.env[KEY_REF];
  await rm(home, { recursive: true, force: true });
});

afterEach(() => {
  mock.state.failModel = {};
  mock.state.mode = 'ok';
});

interface Harness {
  app: Context;
  runtime: LlmRuntime;
  mounted: Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>;
}

async function boot(settings: DuoSettings = {}): Promise<Harness> {
  const app = new Context();
  const runtime = new LlmRuntime(app);
  const mounted = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>();
  app.plugin({
    name: 'test-web-server',
    apply(ctx: Context) {
      ctx.provide('webServer', {
        register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => {
          mounted.set(route.path, route.handler);
          return () => mounted.delete(route.path);
        },
      });
      ctx.provide('connection', { requestRejection: () => undefined });
    },
  });
  await app.plugin(plugin, { baseURL: mock.baseURL, managementURL: mock.baseURL, apiKeyEnv: KEY_REF, ...settings });
  return { app, runtime, mounted };
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function call(provider: string, model: string, sessionId: string): GenerateOptions {
  return {
    provider,
    model,
    sessionId: sessionId as GenerateOptions['sessionId'],
    messages: [createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } })],
  };
}

function completions(since = 0): { model?: unknown }[] {
  return mock.state.requests.slice(since).filter((request) => request.path === '/v1/chat/completions').map((request) => request.body as { model?: unknown });
}

function okFrames(text: string): void {
  mock.state.frames = [
    `{"choices":[{"delta":{"content":"${text}"}}]}`,
    '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}',
    '[DONE]',
  ];
}

describe('pool configuration', () => {
  it('normalizes pools: lowercase, trim, de-duplicate, drop malformed', () => {
    const cfg = resolveDuoConfig({ subagentPool: [' DeepSeek-V4.1-Flash ', 'glm-5.3', 'glm-5.3', 'not an alias!', '', 'glm-5.3-flash'] });
    expect(cfg.subagentPool).toEqual(['deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash']);
    expect(cfg.orchestratorPool).toEqual([]);
  });

  it('maps a pool onto modelIds in order, single alias when empty', () => {
    const pooled = toInferHubSettings(resolveDuoConfig({ subagentPool: ['glm-5.3', 'deepseek-v4.1-flash'] }));
    expect(pooled.routingProfiles?.find((profile) => profile.id === 'sub')?.modelIds).toEqual(['glm-5.3', 'deepseek-v4.1-flash']);
    const single = toInferHubSettings(resolveDuoConfig({}));
    expect(single.routingProfiles?.find((profile) => profile.id === 'sub')?.modelIds).toEqual(['deepseek-v4.1-flash']);
  });

  it('prefixes every pool member in upstream mode', () => {
    const settings = toInferHubSettings(resolveDuoConfig({ subagentPool: ['glm-5.3', 'deepseek-v4.1-flash'], subagentUpstream: 'zai' }));
    expect(settings.routingProfiles?.find((profile) => profile.id === 'sub')?.modelIds).toEqual(['zai/glm-5.3', 'zai/deepseek-v4.1-flash']);
  });

  it('bans a prefix only when it serves no pool member cleanly', () => {
    const membersFor = (alias: string): MinFilterMember[] =>
      alias === 'a'
        ? [
            { prefix: 'p1', id: 'p1/a', minAskIn: 0.001 },
            { prefix: 'p2', id: 'p2/a', minAskIn: 0.02 },
          ]
        : [
            { prefix: 'p1', id: 'p1/b', minAskIn: 0.001 },
            { prefix: 'p2', id: 'p2/b', minAskIn: 0.05 },
          ];
    expect(poolViolatingPrefixes(['a', 'b'], 0.01, undefined, membersFor)).toEqual(['p1']);
    expect(poolViolatingPrefixes(['a'], undefined, undefined, membersFor)).toEqual([]);
  });
});

describe('pool failover walk', () => {
  it('offers every pool member and serves the first with capacity', async () => {
    const harness = await boot({ subagentPool: ['deepseek-v4.1-flash', 'glm-5.3'] });
    const listed = (await harness.runtime.listModels('inferhub-sub')).map((model) => model.id).sort();
    expect(listed).toEqual(['deepseek-v4.1-flash', 'glm-5.3']);
    mock.state.failModel = { 'deepseek-v4.1-flash': { status: 402, code: 'no_provider_under_bid', message: 'no provider under bid' } };
    okFrames('served-by-glm');
    const since = mock.state.requests.length;
    const chunks = await collect(harness.runtime.stream(call('inferhub-sub', 'deepseek-v4.1-flash', 's-pool-walk')));
    expect(chunks.map((chunk) => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
    expect(completions(since).map((body) => body.model)).toEqual(['deepseek-v4.1-flash', 'glm-5.3']);
  });

  it('tries the selected pool member first with a single attempt on success', async () => {
    const harness = await boot({ subagentPool: ['deepseek-v4.1-flash', 'glm-5.3'] });
    okFrames('direct');
    const since = mock.state.requests.length;
    await collect(harness.runtime.stream(call('inferhub-sub', 'glm-5.3', 's-pool-direct')));
    expect(completions(since).map((body) => body.model)).toEqual(['glm-5.3']);
  });

  it('skips pool members the catalogue does not offer', async () => {
    const harness = await boot({ subagentPool: ['nope-unknown', 'glm-5.3'] });
    expect((await harness.runtime.listModels('inferhub-sub')).map((model) => model.id)).toEqual(['glm-5.3']);
    okFrames('known');
    const since = mock.state.requests.length;
    await collect(harness.runtime.stream(call('inferhub-sub', 'glm-5.3', 's-pool-skip')));
    expect(completions(since).map((body) => body.model)).toEqual(['glm-5.3']);
  });

  it('fails with the tried list and last code when every member is exhausted', async () => {
    const harness = await boot({ subagentPool: ['deepseek-v4.1-flash', 'glm-5.3'] });
    mock.state.failModel = {
      'deepseek-v4.1-flash': { status: 402, code: 'no_provider_under_bid', message: 'no provider under bid' },
      'glm-5.3': { status: 503, message: 'no provider served glm-5.3' },
    };
    const since = mock.state.requests.length;
    const chunks = await collect(harness.runtime.stream(call('inferhub-sub', 'deepseek-v4.1-flash', 's-pool-exhausted')));
    const finish = chunks.at(-1);
    expect(finish?.type).toBe('finish');
    expect(JSON.stringify(finish)).toContain('deepseek-v4.1-flash');
    expect(JSON.stringify(finish)).toContain('glm-5.3');
    const models = completions(since).map((body) => body.model);
    expect(models.slice(0, 2)).toEqual(['deepseek-v4.1-flash', 'glm-5.3']);
    expect(models).toContain('deepseek-v4.1-flash');
    expect(models).toContain('glm-5.3');
  });

  it('aborts the walk on non-routable failures', async () => {
    const harness = await boot({ subagentPool: ['deepseek-v4.1-flash', 'glm-5.3'] });
    mock.state.failModel = { 'deepseek-v4.1-flash': { status: 401, message: 'bad key' } };
    const since = mock.state.requests.length;
    const chunks = await collect(harness.runtime.stream(call('inferhub-sub', 'deepseek-v4.1-flash', 's-pool-auth')));
    const finish = chunks.at(-1);
    expect(finish?.type).toBe('finish');
    expect(JSON.stringify(finish)).toContain('AUTH');
    expect(completions(since).map((body) => body.model)).toEqual(['deepseek-v4.1-flash']);
  });

  it('merges minimum floors across pool members without starving either', async () => {
    const harness = await boot({ subagentPool: ['deepseek-v4.1-flash', 'glm-5.3'], subagentMinAskInput: 0.01, subagentMinAskOutput: 0.01 });
    okFrames('floored');
    await collect(harness.runtime.stream(call('inferhub-sub', 'deepseek-v4.1-flash', 's-pool-min')));
    const sent = mock.state.requests.filter((request) => request.path === '/v1/chat/completions').at(-1)!;
    expect(String(sent.headers['x-ignore-upstream'])).toContain('zai');
  });

  it('reports pools and the serving model from the status route', async () => {
    const harness = await boot({ subagentPool: ['deepseek-v4.1-flash', 'glm-5.3'] });
    mock.state.failModel = { 'deepseek-v4.1-flash': { status: 402, code: 'no_provider_under_bid', message: 'no provider under bid' } };
    okFrames('status-served');
    await collect(harness.runtime.stream(call('inferhub-sub', 'deepseek-v4.1-flash', 's-pool-status')));
    const handler = harness.mounted.get(STATUS_PATH);
    expect(handler).toBeDefined();
    const res = {
      statusCode: 0,
      headers: new Map<string, string>(),
      body: '',
      setHeader(this: { headers: Map<string, string> }, key: string, value: string) {
        this.headers.set(key.toLowerCase(), value);
        return this;
      },
      end(this: { body: string }, chunk?: string) {
        if (chunk !== undefined) this.body += chunk;
      },
    };
    await handler!({ method: 'GET', url: STATUS_PATH, headers: {} } as unknown as IncomingMessage, res as unknown as ServerResponse);
    const status = JSON.parse(res.body) as { pools: Record<string, string[]>; activeModels: Record<string, string> };
    expect(status.pools['inferhub-sub']).toEqual(['deepseek-v4.1-flash', 'glm-5.3']);
    expect(status.activeModels['inferhub-sub']).toBe('glm-5.3');
  });
});

describe('pool walk semantics', () => {
  function stubInner(script: Record<string, { chunks?: StreamChunk[]; error?: LlmError }>, calls: string[]): PoolInnerAdapter {
    const fail = (message: string, code: string): never => {
      throw new LlmError(message, code);
    };
    return {
      routeIds: () => ['inferhub-sub'],
      providerInfo: (provider: string) => ({ id: provider, name: provider }),
      providerRetryPolicy: () => undefined,
      imageRequestPricing: () => undefined,
      listModels: async () => [],
      resolveModel: async (_provider: string, model: string) => ({ provider: _provider, id: model, name: model, inputModalities: ['text'] as const, context: { contextWindow: 1 }, defaultMaxTokens: 1 }),
      prepareCall: async (_provider: string, _model: string) => fail('unused', 'NO_ADAPTER'),
      stream: async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls.push(options.model);
        const step = script[options.model];
        for (const chunk of step?.chunks ?? []) yield chunk;
        if (step?.error !== undefined) throw step.error;
      },
    };
  }

  function walkWith(pool: string[], eligible: string[], script: Record<string, { chunks?: StreamChunk[]; error?: LlmError }>): { adapter: PoolFailoverAdapter; calls: string[]; served: [string, string][] } {
    const calls: string[] = [];
    const served: [string, string][] = [];
    const adapter = new PoolFailoverAdapter({
      inner: stubInner(script, calls),
      poolFor: (route: string) => (route === 'inferhub-sub' ? pool : []),
      eligibleModels: (route: string) => (route === 'inferhub-sub' ? eligible : []),
      log: () => undefined,
      noteServed: (route: string, model: string) => {
        served.push([route, model]);
      },
    });
    return { adapter, calls, served };
  }

  function textChunk(text: string): StreamChunk {
    return { type: 'text-delta', index: 0, text };
  }

  function baseOptions(model: string): GenerateOptions {
    return {
      provider: 'inferhub-sub',
      model,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } })],
    };
  }

  it('continues past a pre-token timeout to the next member', async () => {
    const { adapter, calls, served } = walkWith(['a', 'b'], ['a', 'b'], {
      a: { error: new LlmError('timeout', 'TIMEOUT') },
      b: { chunks: [textChunk('bee')] },
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(baseOptions('a'))) chunks.push(chunk);
    expect(chunks).toEqual([textChunk('bee')]);
    expect(calls).toEqual(['a', 'b']);
    expect(served).toEqual([['inferhub-sub', 'b']]);
  });

  it('never retries after output already streamed', async () => {
    const failure = new LlmError('late 503', 'SERVER');
    const { adapter, calls } = walkWith(['a', 'b'], ['a', 'b'], {
      a: { chunks: [textChunk('partial')], error: failure },
      b: { chunks: [textChunk('bee')] },
    });
    const seen: StreamChunk[] = [];
    const caught = await (async () => {
      try {
        for await (const chunk of adapter.stream(baseOptions('a'))) seen.push(chunk);
        return undefined;
      } catch (error: unknown) {
        return error;
      }
    })();
    expect(caught).toBe(failure);
    expect(seen).toEqual([textChunk('partial')]);
    expect(calls).toEqual(['a']);
  });

  it('aborts the walk on quota failures', async () => {
    const failure = new LlmError('out of money', 'QUOTA');
    const { adapter, calls } = walkWith(['a', 'b'], ['a', 'b'], { a: { error: failure } });
    const caught = await adapter.stream(baseOptions('a'))[Symbol.asyncIterator]().next().catch((error: unknown) => error);
    expect(caught).toBe(failure);
    expect(calls).toEqual(['a']);
  });

  it('rethrows the original error verbatim with no pool configured', async () => {
    const failure = new LlmError('solo 503', 'SERVER');
    const { adapter, calls } = walkWith([], [], { a: { error: failure } });
    const iterator = adapter.stream(baseOptions('a'))[Symbol.asyncIterator]();
    const caught = await iterator.next().catch((error: unknown) => error);
    expect(caught).toBe(failure);
    expect(calls).toEqual(['a']);
  });
});
