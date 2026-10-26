/**
 * Ordered pool failover for the duo plugin's two routes.
 *
 * The sibling runtime sends one model id per request and surfaces a typed
 * `LlmError` when InferHub cannot serve it. This wrapper walks a route's
 * configured pool in order — selected model first, then the remaining pool
 * members that the current catalogue generation offers — until one serves.
 * Only failures that mean "this model has no usable capacity right now" move
 * to the next candidate; anything else (auth, budget, bad request, a caller
 * abort, output already streamed) aborts immediately with the original error.
 *
 * @module dsh-inferhub-duo/pool
 */
import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm';
import type {
  GenerateOptions,
  LlmFailure,
  LlmImageRequestPricing,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { NO_CAPACITY_CODE, NO_PROVIDER_UNDER_BID_CODE } from './runtime.ts';
import { minViolatingPrefixes } from './duo-config.ts';
import type { MinFilterMember } from './duo-config.ts';

/** Failure codes that mean "try the next pool member": bid, capacity, 5xx, routing timeout. */
const ROUTABLE_CODES: ReadonlySet<string> = new Set([NO_PROVIDER_UNDER_BID_CODE, NO_CAPACITY_CODE, 'SERVER', 'TIMEOUT']);
/** Terminal error finishes that fail over like capacity failures: a served-but-empty response. */
const FAILOVER_FINISH_CODES: ReadonlySet<string> = new Set([...ROUTABLE_CODES, EMPTY_RESPONSE_CODE]);

/** Read the machine code off a thrown failure without parsing its message. */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'UNKNOWN';
}

/**
 * An assistant turn with no wire-visible content.
 *
 * The harness can record a thinking-only assistant reply, whose blocks are all
 * `reasoning`. On the wire that becomes `{role:"assistant", content:""}`, which
 * CodeBuddy rejects with 400 "Empty message found"; reasoning is not
 * model-visible context, so the turn can be left out of the request.
 */
function isEmptyAssistantTurn(message: GenerateOptions['messages'][number]): boolean {
  if (message.role !== 'assistant') return false;
  return !message.content.some((block) => (block.type === 'text' ? block.text.length > 0 : block.type !== 'reasoning'));
}

function dropEmptyAssistantTurns(messages: GenerateOptions['messages']): GenerateOptions['messages'] {
  const kept = messages.filter((message) => !isEmptyAssistantTurn(message));
  return kept.length === messages.length ? messages : kept;
}

/** A terminal error finish delivered as a chunk (served, but failed). */
function errorFinishOf(chunk: StreamChunk): LlmFailure | undefined {
  if (chunk.type !== 'finish') return undefined;
  const reason = chunk.reason as { kind?: unknown; failure?: unknown } | undefined;
  if (typeof reason !== 'object' || reason === null || reason.kind !== 'error') return undefined;
  const failure = reason.failure as { message?: unknown; code?: unknown } | undefined;
  if (typeof failure !== 'object' || failure === null) return undefined;
  if (typeof failure.message !== 'string' || typeof failure.code !== 'string') return undefined;
  return { message: failure.message, code: failure.code };
}

/** Structural surface of the wrapped sibling adapter used by the walk. */
export interface PoolInnerAdapter {
  routeIds(): string[];
  providerInfo(provider: string): LlmProviderInfo;
  providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined;
  imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

/** Contained diagnostics sink bound to the host logger. */
export type PoolLog = (level: 'info' | 'warn' | 'error', message: string) => void;

/** Dependencies the failover wrapper reads per call. */
export interface PoolFailoverDeps {
  /** The sibling adapter carrying the actual request path. */
  inner: PoolInnerAdapter;
  /** Configured pool (bare aliases, in walk order) for one route id. */
  poolFor: (route: string) => readonly string[];
  /** Exact model ids the live generation currently offers for one route id. */
  eligibleModels: (route: string) => readonly string[];
  log: PoolLog;
  /** Record the model that served a route, for the status surface. */
  noteServed: (route: string, model: string) => void;
}

/**
 * Adapter decorator adding ordered pool failover to `prepareCall`/`stream`.
 *
 * Every other method delegates untouched. With no pool configured the walk is
 * a single attempt and failures surface verbatim, exactly as without the
 * wrapper.
 */
export class PoolFailoverAdapter {
  constructor(private readonly deps: PoolFailoverDeps) {}

  routeIds(): string[] {
    return this.deps.inner.routeIds();
  }

  providerInfo(provider: string): LlmProviderInfo {
    return this.deps.inner.providerInfo(provider);
  }

  providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.deps.inner.providerRetryPolicy(provider);
  }

  imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined {
    return this.deps.inner.imageRequestPricing(provider, model);
  }

  listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.deps.inner.listModels(provider);
  }

  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.deps.inner.resolveModel(provider, model, signal);
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const prepared = await this.deps.inner.prepareCall(provider, model, signal);
    return { model: prepared.model, stream: (options: GenerateOptions) => this.walk(options, options.model ?? prepared.model.id) };
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.walk(options, options.model);
  }

  /** Ordered candidates: the selected model first, then pool members the catalogue offers. */
  private candidates(route: string, selected: string, pool: readonly string[], eligible: readonly string[]): string[] {
    if (pool.length === 0) return [selected];
    const matches = (key: string, alias: string): boolean => key === alias || key.endsWith(`/${alias}`);
    const ordered = eligible.length > 0 ? pool.flatMap((alias) => eligible.filter((key) => matches(key, alias))) : [...pool];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of [selected, ...ordered]) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }

  private async *walk(base: GenerateOptions, selected: string): AsyncIterable<StreamChunk> {
    const route = base.provider;
    const pool = this.deps.poolFor(route);
    const list = this.candidates(route, selected, pool, this.deps.eligibleModels(route));
    const messages = dropEmptyAssistantTurns(base.messages);
    const tried: { model: string; code: string; message: string }[] = [];
    for (const candidate of list) {
      let yielded = false;
      let content = false;
      let swallowed = false;
      try {
        for await (const chunk of this.deps.inner.stream({ ...base, messages, model: candidate })) {
          yielded = true;
          const terminalError = errorFinishOf(chunk);
          if (terminalError !== undefined) {
            if (!content && FAILOVER_FINISH_CODES.has(terminalError.code)) {
              tried.push({ model: candidate, code: terminalError.code, message: terminalError.message });
              this.deps.log('warn', `pool failover on ${route}: ${candidate} returned no content (${terminalError.code}), trying next`);
              swallowed = true;
              break;
            }
            yield chunk;
            return;
          }
          if (chunk.type !== 'usage' && chunk.type !== 'finish') content = true;
          yield chunk;
          if (chunk.type === 'finish') {
            if ((chunk.reason as { kind?: unknown }).kind !== 'aborted') this.deps.noteServed(route, candidate);
            return;
          }
        }
        if (swallowed) continue;
        this.deps.noteServed(route, candidate);
        return;
      } catch (error) {
        if (yielded) throw error;
        if (base.signal?.aborted === true) throw error;
        const code = errorCodeOf(error);
        if (!ROUTABLE_CODES.has(code) || list.length <= 1) throw error;
        tried.push({ model: candidate, code, message: error instanceof Error ? error.message : String(error) });
        this.deps.log('warn', `pool failover on ${route}: ${candidate} failed (${code}), trying next`);
      }
    }
    const last = tried[tried.length - 1];
    if (last === undefined) throw new LlmError(`InferHub pool for route "${route}" has no eligible models`, 'NO_ADAPTER');
    throw new LlmError(
      `InferHub pool exhausted on route "${route}": tried ${tried.map((attempt) => attempt.model).join(', ')}. Last failure (${last.code}): ${last.message}`,
      last.code,
      { cause: last.message },
    );
  }
}

/**
 * Upstream prefixes to exclude for a pool of aliases under minimum asks.
 *
 * A prefix is banned only when it prices at least one pool member below a
 * threshold and serves no pool member at or above the thresholds, so the
 * floor for one alias can never remove another alias's legitimate supply.
 * Prefixes without ask data are always kept.
 */
export function poolViolatingPrefixes(
  aliases: readonly string[],
  minAskInput: number | undefined,
  minAskOutput: number | undefined,
  membersFor: (alias: string) => readonly MinFilterMember[],
): string[] {
  if (aliases.length === 0 || (minAskInput === undefined && minAskOutput === undefined)) return [];
  const violators = new Map<string, Set<string>>();
  const servers = new Map<string, Set<string>>();
  for (const alias of aliases) {
    const members = membersFor(alias);
    for (const member of members) {
      let served = servers.get(member.prefix);
      if (served === undefined) {
        served = new Set<string>();
        servers.set(member.prefix, served);
      }
      served.add(alias);
    }
    for (const prefix of minViolatingPrefixes(alias, minAskInput, minAskOutput, members)) {
      let banned = violators.get(prefix);
      if (banned === undefined) {
        banned = new Set<string>();
        violators.set(prefix, banned);
      }
      banned.add(alias);
    }
  }
  const banned: string[] = [];
  for (const [prefix, failed] of violators) {
    const served = servers.get(prefix) ?? new Set<string>();
    if (failed.size === 0) continue;
    let clean = false;
    for (const alias of served) {
      if (!failed.has(alias)) {
        clean = true;
        break;
      }
    }
    if (!clean) banned.push(prefix);
  }
  return banned;
}
