/**
 * dsh-inferhub-duo: entry point.
 *
 * This plugin exposes exactly two InferHub routes over the proven dsh-inferhub
 * runtime next door — `inferhub-orch` (an orchestrator alias) and `inferhub-sub`
 * (a subagent alias). Both run in `cheapest` mode: a bare alias id with the
 * route's ceilings pinned to the model's live cheapest ask, so only the cheapest
 * ask tier is eligible.
 *
 * Composition order matters. Routes are *settings-derived* but
 * *catalogue-populated*: the plugin registers both routes the moment it starts
 * (so the model picker always lists them), then keeps swapping that registration
 * as settings change and as the catalogue refreshes. The swap is atomic — a
 * rejected route set leaves the previous, working pair in place.
 *
 * @module dsh-inferhub-duo
 */
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm';
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type { Context } from '@deepseek-ai/cordis';
// Type-only: applies the settings seam's Context augmentation without importing
// the service at runtime (the plugin stays usable when no settings provider is composed).
import type {} from '@deepseek-ai/dsh-settings';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CatalogService,
  SpendLedger,
  InferHubAdapter,
  InferHubClient,
  deriveRoutes,
  indexRoutes,
  describeRoute,
  describe,
  resolveInferHubConfig,
  retryPolicyOf,
  rejected,
  sendJson,
  sendMethodNotAllowed,
} from './runtime.ts';
import type { AdapterGeneration, CatalogSnapshot, InferHubConfig, RouteSpec } from './runtime.ts';
import { DUO_SETTINGS_NAMESPACE, MANAGEMENT_CALLS_PER_MINUTE, ORCHESTRATOR_PROFILE_ID, SUBAGENT_PROFILE_ID, Config, minViolatingPrefixes, resolveDuoConfig, toInferHubSettings } from './duo-config.ts';
import type { DuoConfig, DuoSettings, MinFilterMember } from './duo-config.ts';

/** Cordis function-plugin name. */
export const name = 'dsh-inferhub-duo';

/** Required host services: the LLM registry the adapter registers routes with. */
export const inject = ['llm'];

/** Read-only status document for this plugin (kept off the `/dsh-inferhub/*` paths to avoid collision). */
export const STATUS_PATH = '/dsh-inferhub-duo/status';

/** The host web-server surface this plugin mounts its status route on. */
interface WebServerRegister {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void;
}

/** A context that carries the optional `webServer` service. */
interface DuoRouteContext extends Context {
  webServer: WebServerRegister;
}

/** Contained diagnostics sink bound to the host logger. */
function loggerFor(ctx: Context): (level: 'info' | 'warn' | 'error', message: string) => void {
  const logger = Reflect.get(ctx, 'logger') as Record<'info' | 'warn' | 'error', (message: string) => void> | undefined;
  return (level, message) => {
    const text = `${name}: ${message}`;
    const sink = logger?.[level];
    if (typeof sink === 'function') {
      sink.call(logger, text);
      return;
    }
    if (level === 'error') console.error(text);
    else if (level === 'warn') console.warn(text);
    else console.log(text);
  };
}

/**
 * Register the two cheapest InferHub routes, their settings section, and a
 * read-only status surface.
 * @param ctx - host plugin context carrying the LLM registry.
 * @param config - the composition-layer configuration entry.
 */
export function apply(ctx: Context, config: DuoSettings): void {
  const log = loggerFor(ctx);
  let current = (): DuoSettings => config;
  let lastRaw: DuoSettings | undefined;
  let lastGood: DuoConfig | undefined;

  /** Resolve duo configuration, keeping the last good one after an invalid edit. */
  const options = (): DuoConfig => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      const next = resolveDuoConfig(raw);
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      lastRaw = raw;
      log('error', `keeping the last good configuration after an invalid settings section: ${describe(error)}`);
      return lastGood;
    }
  };

  /** The dsh-inferhub runtime configuration derived from the current duo settings. */
  const inferConfig = (): InferHubConfig => resolveInferHubConfig(toInferHubSettings(options()));

  const clientFor = () => {
    const cfg = options();
    return new InferHubClient({
      baseURL: cfg.baseURL,
      managementURL: cfg.managementURL,
      managementCallsPerMinute: MANAGEMENT_CALLS_PER_MINUTE,
      requestTimeoutMs: cfg.requestTimeoutMs,
    });
  };

  const resolveApiKey = async (): Promise<string | undefined> => {
    const ref = options().apiKeyEnv;
    let parsed: ReturnType<typeof credentialRef> | undefined;
    try {
      parsed = credentialRef(ref);
    } catch {
      parsed = undefined;
    }
    const credentials = ctx.get('credentials') as { resolve: (reference: unknown) => Promise<{ value: string } | undefined> } | undefined;
    if (credentials !== undefined && parsed !== undefined) {
      const hit = await credentials.resolve(parsed);
      if (hit !== undefined && hit.value.trim().length > 0) return assertUsableApiKey(hit.value.trim(), name, ref);
    }
    const ambient = process.env[ref];
    if (ambient !== undefined && ambient.trim().length > 0) return assertUsableApiKey(ambient.trim(), name, ref);
    return undefined;
  };

  const ledger = new SpendLedger(log);
  let lastSpecs: RouteSpec[] = [];
  let generation: AdapterGeneration = { routes: new Map(), config: inferConfig() };
  let registration: AdapterRegistrationHandle | undefined;

  const catalog = new CatalogService({
    client: clientFor,
    apiKey: resolveApiKey,
    ttlMs: () => options().catalogTtlSeconds * 1000,
    timezone: () => options().timezone,
    log,
    onSnapshot: (snapshot: CatalogSnapshot) => {
      ledger.setReported(snapshot.account);
      rebuild();
    },
  });

  const adapter = new InferHubAdapter({
    apiKey: resolveApiKey,
    generation: () => generation,
    client: clientFor,
    catalog,
    ledger,
    retryPolicy: () => retryPolicyOf(inferConfig()),
    log,
  });

  /**
   * Re-derive the two routes and swap the registration.
   *
   * The registration is replaced *before* the generation is published, so a
   * rejected route set leaves the previous, working pair in place rather than a
   * generation the LLM service cannot reach.
   */
  function rebuild(): void {
    const runtime = inferConfig();
    let specs: RouteSpec[];
    try {
      specs = deriveRoutes(runtime, catalog.peek());
    } catch (error) {
      log('error', `route derivation failed, keeping the previous routes: ${describe(error)}`);
      return;
    }
    applyMinAskFilters(specs, options(), catalog.peek());
    const ids = specs.map((route) => route.route);
    const previousSpecs = lastSpecs;
    const previousGeneration = generation;
    // `replace` captures each route's display name through `providerInfo`, so the
    // new spec must be visible before the swap. The swap is synchronous, so
    // publishing first is not observable until it either commits or is rolled
    // back below — which is what keeps a rejected route set from stranding the
    // picker with names for routes that are not registered.
    lastSpecs = specs;
    generation = { routes: indexRoutes(specs), config: runtime };
    if (registration !== undefined) {
      try {
        registration.replace(ids);
      } catch (error) {
        lastSpecs = previousSpecs;
        generation = previousGeneration;
        log('error', `provider route swap was rejected, keeping the previous routes: ${describe(error)}`);
        return;
      }
    }
    const empty = specs.filter((route) => route.empty).map((route) => route.route);
    if (empty.length > 0) log('warn', `routes with no eligible models in the current catalogue: ${empty.join(', ')}`);
  }

  /** Snapshot shapes read for minimum filtering, tolerant of either catalogue form. */
  interface SnapshotUpstreamModel {
    prefix?: unknown;
    upstreamModelId?: unknown;
    minAskIn?: unknown;
    minAskOut?: unknown;
  }
  interface SnapshotUpstream {
    prefix?: unknown;
    models?: SnapshotUpstreamModel[];
  }
  interface SnapshotModel {
    id?: unknown;
    ownedBy?: unknown;
    outputModality?: unknown;
    minAskIn?: unknown;
    minAskOut?: unknown;
  }
  /** Priced member rows for one alias, from upstream cards or routable rows. */
  function minFilterMembers(snapshot: unknown, alias: string): MinFilterMember[] {
    const snap = snapshot as { upstreams?: unknown; models?: unknown } | null | undefined;
    const upstreamsRaw: unknown = snap?.upstreams;
    const upstreams: SnapshotUpstream[] = Array.isArray(upstreamsRaw) ? (upstreamsRaw as SnapshotUpstream[]) : [];
    if (upstreams.length > 0) {
      const members: MinFilterMember[] = [];
      for (const upstream of upstreams) {
        if (typeof upstream?.prefix !== 'string') continue;
        for (const model of Array.isArray(upstream.models) ? upstream.models : []) {
          if (typeof model?.upstreamModelId !== 'string') continue;
          const tail = model.upstreamModelId.includes('/') ? (model.upstreamModelId.split('/').pop() as string) : model.upstreamModelId;
          if (tail !== alias) continue;
          members.push({
            prefix: upstream.prefix,
            id: `${upstream.prefix}/${model.upstreamModelId}`,
            ...(typeof model.minAskIn === 'number' ? { minAskIn: model.minAskIn } : {}),
            ...(typeof model.minAskOut === 'number' ? { minAskOut: model.minAskOut } : {}),
          });
        }
      }
      return members;
    }
    const modelsRaw: unknown = snap?.models;
    const models: SnapshotModel[] = Array.isArray(modelsRaw) ? (modelsRaw as SnapshotModel[]) : [];
    const members: MinFilterMember[] = [];
    for (const model of models) {
      if (typeof model?.id !== 'string') continue;
      const ownedBy = typeof model.ownedBy === 'string' ? model.ownedBy : (model.id.includes('/') ? (model.id.split('/')[0] as string) : 'alias');
      if (ownedBy === 'alias' || ownedBy === 'combo' || model.id.startsWith('free/')) continue;
      if (model.outputModality !== undefined && model.outputModality !== 'text') continue;
      members.push({
        prefix: model.id.includes('/') ? (model.id.split('/')[0] as string) : ownedBy,
        id: model.id,
        ...(typeof model.minAskIn === 'number' ? { minAskIn: model.minAskIn } : {}),
        ...(typeof model.minAskOut === 'number' ? { minAskOut: model.minAskOut } : {}),
      });
    }
    return members;
  }

  /**
   * Fold each route's minimum asks into its ignored upstreams.
   *
   * A pinned route keeps its explicit trust; every other route drops the
   * prefixes serving its alias below either threshold, so sub-minimum tiers
   * never win the server-side walk even with free capacity.
   */
  function applyMinAskFilters(specs: RouteSpec[], duo: DuoConfig, snapshot: unknown): void {
    if (snapshot === undefined || snapshot === null) return;
    for (const spec of specs) {
      const pair =
        spec.profileId === ORCHESTRATOR_PROFILE_ID
          ? { alias: duo.orchestratorAlias, minIn: duo.orchestratorMinAskInput, minOut: duo.orchestratorMinAskOutput }
          : spec.profileId === SUBAGENT_PROFILE_ID
            ? { alias: duo.subagentAlias, minIn: duo.subagentMinAskInput, minOut: duo.subagentMinAskOutput }
            : undefined;
      if (pair === undefined || spec.mode === 'upstream') continue;
      const banned = minViolatingPrefixes(pair.alias, pair.minIn, pair.minOut, minFilterMembers(snapshot, pair.alias));
      if (banned.length === 0) continue;
      spec.ignoreUpstreams = [...new Set([...spec.ignoreUpstreams, ...banned])];
      log('warn', `minimum asks exclude ${banned.join(', ')} from ${spec.route} (${pair.alias})`);
    }
  }

  const initialSpecs: RouteSpec[] = deriveRoutes(inferConfig(), undefined);  lastSpecs = initialSpecs;
  generation = { routes: indexRoutes(initialSpecs), config: inferConfig() };
  registration = ctx.llm.registerAdapter(
    initialSpecs.map((route) => route.route),
    adapter,
  );
  log('info', `registered ${String(initialSpecs.length)} provider route(s): ${initialSpecs.map((route) => route.route).join(', ')}`);

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, DUO_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source: () => DuoSettings) => {
        current = source;
      },
      onChange: () => {
        rebuild();
      },
    });
  });

  ctx.inject(['webServer'], (routeCtx) => {
    const host = routeCtx as unknown as DuoRouteContext;
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: STATUS_PATH,
          handler: async (req: IncomingMessage, res: ServerResponse) => {
            if (rejected(host, req, res)) return;
            if (req.method !== 'GET') {
              sendMethodNotAllowed(res, 'GET');
              return;
            }
            const cfg = options();
            const snapshot = catalog.peek();
            const spend = ledger.snapshot(Date.now(), cfg.timezone);
            sendJson(res, 200, {
              routes: lastSpecs.map((route) => describeRoute(route)),
              models: lastSpecs.flatMap((route) => route.models.map((model) => model.id)),
              ceilings: cfg.ceilings,
              stale: snapshot === undefined ? true : snapshot.stale,
              spend: {
                ...(spend.sessionId === undefined ? {} : { sessionId: spend.sessionId }),
                session: spend.session,
                day: spend.day,
                month: spend.month,
                recent: spend.recent.slice(0, 25),
              },
            });
          },
        }),
      `${name}: status route`,
    );
  });

  ctx.effect(() => {
    void (async () => {
      await ledger.load();
      rebuild();
      try {
        await catalog.get();
      } catch (error) {
        log('warn', `initial catalogue read failed (the model picker will report it until a key or network is available): ${describe(error)}`);
      }
    })();
    return () => {
      void ledger.dispose();
    };
  }, `${name}: ledger and first catalogue read`);
}

export { Config, resolveDuoConfig, toInferHubSettings };
export type { DuoConfig, DuoSettings };
