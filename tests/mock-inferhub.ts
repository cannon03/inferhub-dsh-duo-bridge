/**
 * A local stand-in for InferHub's inference and management surfaces, shared by
 * the duo integration tests. Mirrors the mock the dsh-inferhub suite drives so
 * the same wire contract is exercised.
 *
 * @module dsh-inferhub-duo/tests/mock-inferhub
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { wireAccount, wireAliasBudgets, wireCatalog, wireCombos, wireModels } from './fixtures.ts';

/** One recorded mock request. */
export interface RecordedRequest {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** Mutable mock behaviour plus the request journal. */
export interface MockState {
  requests: RecordedRequest[];
  /** `bid` answers inference with InferHub's `no_provider_under_bid`. */
  mode: 'ok' | 'bid';
  /** When true, the management surface answers 403 like keys without management scope. */
  managementForbidden: boolean;
  /** SSE frames the inference endpoint writes; a `{...}` payload is wrapped in `data: `. */
  frames: string[];
  /** Per-model SSE frames, keyed by the request's `model` id; falls back to `frames`. */
  framesFor: Record<string, string[]>;
  /** Per-model inference failures, keyed by the request's `model` id. */
  failModel: Record<string, { status: number; code?: string; message?: string }>;
}

/** A started mock, addressable by the plugin's `baseURL`. */
export interface MockInferHub {
  baseURL: string;
  state: MockState;
  close(): Promise<void>;
}

/** Read one request body as JSON (or text when it is not JSON). */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Send one JSON document. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Start the mock on an ephemeral port. */
export async function startMockInferHub(): Promise<MockInferHub> {
  const state: MockState = { requests: [], mode: 'ok', managementForbidden: false, frames: [], failModel: {}, framesFor: {} };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(String(req.url), 'http://localhost').pathname;
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      state.requests.push({ path, method: req.method ?? 'GET', headers: req.headers, ...(body === undefined ? {} : { body }) });
      if (path === '/v1/models') {
        json(res, 200, { data: wireModels });
        return;
      }
      if (path === '/catalog' || path === '/combos' || path === '/budgets/aliases') {
        if (state.managementForbidden) {
          json(res, 403, { error: { message: 'forbidden' } });
          return;
        }
        if (path === '/catalog') {
          json(res, 200, wireCatalog);
          return;
        }
        if (path === '/combos') {
          json(res, 200, wireCombos);
          return;
        }
        json(res, 200, wireAliasBudgets);
        return;
      }
      if (path === '/v1/me/usage') {
        json(res, 200, wireAccount);
        return;
      }
      if (path === '/v1/chat/completions') {
        const fail = typeof body === 'object' && body !== null && 'model' in body ? state.failModel[String((body as { model?: unknown }).model)] : undefined;
        if (fail !== undefined) {
          json(res, fail.status, { error: { ...(fail.code === undefined ? {} : { code: fail.code }), message: fail.message ?? 'mock failure' } });
          return;
        }
        if (state.mode === 'bid') {
          json(res, 402, {
            error: { code: 'no_provider_under_bid', message: 'no provider under bid', min_input_per_mtok: 0.005, min_output_per_mtok: 0.02 },
          });
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        const model = typeof body === 'object' && body !== null && 'model' in body ? String((body as { model?: unknown }).model) : '';
        const frames = state.framesFor[model] ?? state.frames;
        for (const frame of frames) res.write(frame.startsWith('{') || frame.startsWith('[') ? `data: ${frame}\n\n` : frame);
        res.end();
        return;
      }
      json(res, 404, { error: { message: `unexpected ${req.method} ${path}` } });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${String(address.port)}`,
    state,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
