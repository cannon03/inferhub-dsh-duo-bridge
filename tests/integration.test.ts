/**
 * Boot integration: the duo plugin inside a real cordis app and the harness's
 * own `LlmRuntime`, against a local mock InferHub.
 *
 * This is the offline equivalent of what a harness restart proves — route
 * registration, the picker's model catalogue for both routes, cheapest
 * ceilings on the wire, the status route, and live reconfiguration of the
 * orchestrator/subagent pair — with none of the GUI's moving parts.
 *
 * @module dsh-inferhub-duo/tests/integration
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import * as fileSettings from '@deepseek-ai/dsh-settings-file';
import type {} from '@deepseek-ai/dsh-settings';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as plugin from '../src/index.ts';
import { STATUS_PATH } from '../src/index.ts';
import type { DuoSettings } from '../src/duo-config.ts';
import { startMockInferHub, type MockInferHub } from './mock-inferhub.ts';

/** Credential reference the test env supplies, so no credential service is needed. */
const KEY_REF = 'INFERHUB_API_KEY_DUO_INTEGRATION';

let mock: MockInferHub;
let home = '';
let previousHome: string | undefined;

beforeAll(async () => {
  mock = await startMockInferHub();
  home = await mkdtemp(join(tmpdir(), 'dsh-inferhub-duo-home-'));
  previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  process.env[KEY_REF] = 'sk-airo-duo-integration';
});

afterAll(async () => {
  await mock.close();
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  delete process.env[KEY_REF];
  await rm(home, { recursive: true, force: true });
});

/** A fake `webServer` service plus a fake connection fence, recording mounts. */
interface Harness {
  app: Context;
  runtime: LlmRuntime;
  mounted: Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>;
}

/** Boot a fresh app with the duo plugin installed. */
async function boot(settings: DuoSettings = {}, options: { withSettings?: boolean } = {}): Promise<Harness> {
  const app = new Context();
  const runtime = new LlmRuntime(app);
  const mounted = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>();
  if (options.withSettings === true) await app.plugin(fileSettings.default, {});
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

/** Collect a chunk stream. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** One minimal request against a route, carrying a session the ledger can bucket. */
function call(provider: string, model: string, sessionId: string): GenerateOptions {
  return {
    provider,
    model,
    sessionId: sessionId as GenerateOptions['sessionId'],
    messages: [createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } })],
  };
}

/** Drive the plugin's own status route through the fake web server. */
async function readStatus(harness: Harness): Promise<Record<string, unknown>> {
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
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as Record<string, unknown>;
}

describe('duo plugin boot', () => {
  it('registers the orchestrator, subagent and CB routes', async () => {
    const harness = await boot();
    expect(harness.runtime.listProviders().map((provider) => provider.id)).toEqual(['inferhub-orch', 'inferhub-sub', 'inferhub-cb']);
    expect(harness.runtime.listProviders().map((provider) => provider.name)).toEqual([
      'InferHub Orchestrator',
      'InferHub Subagent',
      'InferHub CB',
    ]);
  });

  it('lists exactly one cheapest alias per route, pinned to its live floor', async () => {
    const harness = await boot();
    const orch = await harness.runtime.listModels('inferhub-orch');
    expect(orch).toEqual([
      {
        provider: 'inferhub-orch',
        id: 'glm-5.3',
        name: 'GLM 5.3',
        description: expect.stringContaining('cheapest'),
        inputModalities: ['text'],
      },
    ]);
    // Z.AI's ask is the live floor for the glm-5.3 alias.
    expect(orch[0]!.description).toContain('ceiling in $0.0014/M out $0.0044/M');

    const sub = await harness.runtime.listModels('inferhub-sub');
    expect(sub.map((model) => model.id)).toEqual(['deepseek-v4.1-flash']);
    // CodeBuddy's ask is the live floor for the deepseek-v4.1-flash alias.
    expect(sub[0]!.description).toContain('ceiling in $0.00015/M out $0.0006/M');
  });

  it('resolves model info for both aliases', async () => {
    const harness = await boot();
    // The picker lists first (loading the catalogue); resolution then reads it.
    await harness.runtime.listModels('inferhub-orch');
    await harness.runtime.listModels('inferhub-sub');
    const orch = await harness.runtime.resolveModelInfo('inferhub-orch', 'glm-5.3');
    expect(orch.id).toBe('glm-5.3');
    const sub = await harness.runtime.resolveModelInfo('inferhub-sub', 'deepseek-v4.1-flash');
    expect(sub.id).toBe('deepseek-v4.1-flash');
    expect(sub.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'high']);
  });

  it('streams through the subagent route with floor-pinned ceilings and records the spend', async () => {
    mock.state.mode = 'ok';
    mock.state.frames = [
      '{"choices":[{"delta":{"content":"pong"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":1,"cost":0.00002},"upstream_label":"CodeBuddy"}',
      '[DONE]',
    ];
    const harness = await boot({ budgets: { session: 1, warnPercent: 0.8, enforce: true } });
    const chunks = await collect(harness.runtime.stream(call('inferhub-sub', 'deepseek-v4.1-flash', 's-duo-sub')));
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'pong' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'pong' } },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
    const sent = mock.state.requests.filter((request) => request.path === '/v1/chat/completions').at(-1)!;
    expect(sent.headers['x-max-input-price']).toBe('0.00015');
    expect(sent.headers['x-max-output-price']).toBe('0.0006');

    const status = await readStatus(harness);
    const spend = status.spend as { sessionId?: string; session: { spent: number; requests: number } };
    expect(spend.sessionId).toBe('s-duo-sub');
    expect(spend.session).toMatchObject({ spent: 0.00002, requests: 1 });
  });

  it('streams through the orchestrator route with its own floor-pinned ceilings', async () => {
    mock.state.mode = 'ok';
    mock.state.frames = [
      '{"choices":[{"delta":{"content":"planned"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1},"upstream_label":"Z.AI"}',
      '[DONE]',
    ];
    const harness = await boot();
    const chunks = await collect(harness.runtime.stream(call('inferhub-orch', 'glm-5.3', 's-duo-orch')));
    expect(chunks.map((chunk) => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
    const sent = mock.state.requests.filter((request) => request.path === '/v1/chat/completions').at(-1)!;
    expect(sent.body).toMatchObject({ model: 'glm-5.3' });
    expect(sent.headers['x-max-input-price']).toBe('0.0014');
    expect(sent.headers['x-max-output-price']).toBe('0.0044');
  });

  it('serves the CB-pinned model on its own route', async () => {
    mock.state.mode = 'ok';
    mock.state.frames = [
      '{"choices":[{"delta":{"content":"kimi"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1},"upstream_label":"CodeBuddy"}',
      '[DONE]',
    ];
    const harness = await boot();
    const listed = await harness.runtime.listModels('inferhub-cb');
    expect(listed.map((model) => model.id)).toEqual(['cb/kimi-k3.1-pro']);
    const chunks = await collect(harness.runtime.stream(call('inferhub-cb', 'cb/kimi-k3.1-pro', 's-duo-cb')));
    expect(chunks.map((chunk) => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
    const sent = mock.state.requests.filter((request) => request.path === '/v1/chat/completions').at(-1)!;
    expect(sent.body).toMatchObject({ model: 'cb/kimi-k3.1-pro' });
    expect(sent.headers['x-ignore-upstream']).toBeUndefined();
  });

  it('strips thinking-only assistant turns before the wire', async () => {
    mock.state.mode = 'ok';
    mock.state.frames = [
      '{"choices":[{"delta":{"content":"ok"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1},"upstream_label":"CodeBuddy"}',
      '[DONE]',
    ];
    const harness = await boot();
    const options = {
      ...call('inferhub-cb', 'cb/kimi-k3.1-pro', 's-duo-cb-clean'),
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }),
        createAssistantMessage({
          content: [{ type: 'reasoning', text: 'thinking only' }],
          source: { provider: 'inferhub-cb', model: 'cb/kimi-k3.1-pro' },
        }),
        createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
      ],
    };
    await collect(harness.runtime.stream(options));
    const sent = mock.state.requests.filter((request) => request.path === '/v1/chat/completions').at(-1)!;
    const messages = (sent.body as { messages: { role: string }[] }).messages;
    expect(messages.map((message) => message.role)).toEqual(['user', 'user']);
  });

  it('reports all three routes from the status route', async () => {
    const harness = await boot();
    await harness.runtime.listModels('inferhub-orch');
    expect([...harness.mounted.keys()]).toEqual([STATUS_PATH]);
    const status = await readStatus(harness);
    expect((status.routes as { route: string }[]).map((route) => route.route)).toEqual(['inferhub-orch', 'inferhub-sub', 'inferhub-cb']);
    expect(status.models).toEqual(['glm-5.3', 'deepseek-v4.1-flash', 'cb/kimi-k3.1-pro']);
    expect(status.stale).toBe(false);
  });

  it('swaps the pair from a live settings write, with no restart', async () => {
    const harness = await boot({}, { withSettings: true });
    expect((await harness.runtime.listModels('inferhub-orch')).map((model) => model.id)).toEqual(['glm-5.3']);

    await harness.app.settings.update('inferhub-duo', { orchestratorAlias: 'deepseek-v4.1-flash' });
    expect(((await harness.runtime.listModels('inferhub-orch')).map((model) => model.id))).toEqual(['deepseek-v4.1-flash']);

    // A malformed alias degrades to the default instead of emptying the route.
    await harness.app.settings.update('inferhub-duo', { subagentAlias: 'not an alias!' });
    expect((await harness.runtime.listModels('inferhub-sub')).map((model) => model.id)).toEqual(['deepseek-v4.1-flash']);

    // A well-formed but unknown alias leaves an empty route rather than widening.
    await harness.app.settings.update('inferhub-duo', { subagentAlias: 'glm-9.9' });
    expect(await harness.runtime.listModels('inferhub-sub')).toEqual([]);
  });

  it('fails the picker with an actionable message when no credential resolves', async () => {
    delete process.env[KEY_REF];
    const harness = await boot();
    const failure = await harness.runtime.listModels('inferhub-orch').catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'CATALOG_UNAVAILABLE' });
    expect((failure as Error).message).toContain('InferHub API key is not configured');
    process.env[KEY_REF] = 'sk-airo-duo-integration';
  });

  it('serves floor-pinned cheapest routes when the management surface is forbidden', async () => {
    mock.state.managementForbidden = true;
    try {
      const harness = await boot();
      const orch = await harness.runtime.listModels('inferhub-orch');
      expect(orch.map((model) => model.id)).toEqual(['glm-5.3']);
      expect(orch[0]!.description).toContain('ceiling in $0.0014/M out $0.0044/M');
      const sub = await harness.runtime.listModels('inferhub-sub');
      expect(sub.map((model) => model.id)).toEqual(['deepseek-v4.1-flash']);
      expect(sub[0]!.description).toContain('ceiling in $0.00015/M out $0.0006/M');
    } finally {
      mock.state.managementForbidden = false;
    }
  });

  it('runs a route in auto mode with no price headers, failing over by itself', async () => {
    const harness = await boot({ orchestratorAuto: true });
    const orch = await harness.runtime.listModels('inferhub-orch');
    expect(orch.map((model) => model.id)).toEqual(['glm-5.3']);
    expect(orch[0]!.description).toContain('auto');
    expect(orch[0]!.description).not.toContain('ceiling');
    mock.state.mode = 'ok';
    mock.state.frames = [
      '{"choices":[{"delta":{"content":"planned"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1},"upstream_label":"Z.AI"}',
      '[DONE]',
    ];
    const chunks = await collect(harness.runtime.stream(call('inferhub-orch', 'glm-5.3', 's-duo-auto')));
    expect(chunks.map((chunk) => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
    const sent = mock.state.requests.filter((request) => request.path === '/v1/chat/completions').at(-1)!;
    expect(sent.body).toMatchObject({ model: 'glm-5.3' });
    expect(sent.headers['x-max-input-price']).toBeUndefined();
    expect(sent.headers['x-max-output-price']).toBeUndefined();
  });

  it('pins a route to one upstream so only that provider serves', async () => {
    const harness = await boot({ orchestratorUpstream: 'zai' });
    const orch = await harness.runtime.listModels('inferhub-orch');
    expect(orch.map((model) => model.id)).toEqual(['zai/glm-5.3']);
    expect(orch[0]!.description).toContain('Z.AI');
    mock.state.mode = 'ok';
    mock.state.frames = [
      '{"choices":[{"delta":{"content":"planned"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1},"upstream_label":"Z.AI"}',
      '[DONE]',
    ];
    const chunks = await collect(harness.runtime.stream(call('inferhub-orch', 'zai/glm-5.3', 's-duo-pinned')));
    expect(chunks.map((chunk) => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
    const sent = mock.state.requests.filter((request) => request.path === '/v1/chat/completions').at(-1)!;
    expect(sent.body).toMatchObject({ model: 'zai/glm-5.3' });
  });

  it('excludes sub-minimum upstreams from the wire request', async () => {
    const harness = await boot({ orchestratorMinAskInput: 0.01, orchestratorMinAskOutput: 0.01 });
    expect((await harness.runtime.listModels('inferhub-orch')).map((model) => model.id)).toEqual(['glm-5.3']);
    mock.state.mode = 'ok';
    mock.state.frames = [
      '{"choices":[{"delta":{"content":"planned"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1},"upstream_label":"CodeBuddy"}',
      '[DONE]',
    ];
    await collect(harness.runtime.stream(call('inferhub-orch', 'glm-5.3', 's-duo-min')));
    const sent = mock.state.requests.filter((request) => request.path === '/v1/chat/completions').at(-1)!;
    expect(String(sent.headers['x-ignore-upstream'])).toContain('zai');
    expect(String(sent.headers['x-ignore-upstream'])).not.toContain('cb');
  });

  it('excludes sub-minimum upstreams from member rows when the catalogue is forbidden', async () => {
    mock.state.managementForbidden = true;
    try {
      const harness = await boot({ orchestratorMinAskInput: 0.01, orchestratorMinAskOutput: 0.01 });
      expect((await harness.runtime.listModels('inferhub-orch')).map((model) => model.id)).toEqual(['glm-5.3']);
      mock.state.mode = 'ok';
      mock.state.frames = [
        '{"choices":[{"delta":{"content":"planned"}}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1},"upstream_label":"CodeBuddy"}',
        '[DONE]',
      ];
      await collect(harness.runtime.stream(call('inferhub-orch', 'glm-5.3', 's-duo-min-degraded')));
      const sent = mock.state.requests.filter((request) => request.path === '/v1/chat/completions').at(-1)!;
      expect(String(sent.headers['x-ignore-upstream'])).toContain('zai');
    } finally {
      mock.state.managementForbidden = false;
    }
  });

  it('never empties a route when the minimum excludes everything', async () => {
    const harness = await boot({ orchestratorMinAskInput: 99, orchestratorMinAskOutput: 99 });
    expect((await harness.runtime.listModels('inferhub-orch')).map((model) => model.id)).toEqual(['glm-5.3']);
    mock.state.mode = 'ok';
    mock.state.frames = [
      '{"choices":[{"delta":{"content":"planned"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1},"upstream_label":"Z.AI"}',
      '[DONE]',
    ];
    await collect(harness.runtime.stream(call('inferhub-orch', 'glm-5.3', 's-duo-min-empty')));
    const sent = mock.state.requests.filter((request) => request.path === '/v1/chat/completions').at(-1)!;
    expect(sent.headers['x-ignore-upstream']).toBeUndefined();
  });

  it('runs a route constrained at explicit ceilings, admitting backup tiers', async () => {
    const harness = await boot({ orchestratorCeilings: { input: 0.025, output: 0.08 } });
    const orch = await harness.runtime.listModels('inferhub-orch');
    expect(orch.map((model) => model.id)).toEqual(['glm-5.3']);
    expect(orch[0]!.description).toContain('price-capped');
    expect(orch[0]!.description).toContain('ceiling in $0.025/M out $0.08/M');
    mock.state.mode = 'ok';
    mock.state.frames = [
      '{"choices":[{"delta":{"content":"planned"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1},"upstream_label":"Z.AI"}',
      '[DONE]',
    ];
    const chunks = await collect(harness.runtime.stream(call('inferhub-orch', 'glm-5.3', 's-duo-constrained')));
    expect(chunks.map((chunk) => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
    const sent = mock.state.requests.filter((request) => request.path === '/v1/chat/completions').at(-1)!;
    expect(sent.headers['x-max-input-price']).toBe('0.025');
    expect(sent.headers['x-max-output-price']).toBe('0.08');
  });
});
