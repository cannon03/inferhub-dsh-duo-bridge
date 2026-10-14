/**
 * Configuration schema and normalization for the InferHub duo plugin.
 *
 * The duo plugin exposes exactly two cheapest routes — an orchestrator route
 * (`inferhub-orch`) and a subagent route (`inferhub-sub`) — each serving one
 * configurable InferHub alias or, when set, an ordered pool of aliases walked
 * until one serves. The `Config` schema is the settings-namespace
 * schema the plugin installs under `inferhub-duo`, so every field here is
 * user-editable at runtime through `settings.yaml`.
 *
 * `resolveDuoConfig` is the single path from stored values to validated facts:
 * it trims, clamps, normalizes aliases, and falls back to defaults on anything
 * malformed, so the rest of the plugin only ever sees sane input. It never
 * throws: a bad stored alias degrades to the default alias rather than bricking
 * both routes.
 *
 * `toInferHubSettings` maps the resolved duo settings onto the dsh-inferhub
 * runtime's `InferHubSettings`, so the proven catalogue/routing/adapter
 * machinery next door can be reused untouched.
 *
 * @module dsh-inferhub-duo/duo-config
 */
import z from '@deepseek-ai/schemastery';
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import type { InferHubSettings, PriceCeilings, RoutingProfileSetting } from './runtime.ts';

/**
 * Stored duo settings — the `inferhub-duo` settings-namespace shape.
 *
 * Every field is optional because the settings document is a user layer over the
 * composition defaults: a stored section normally names only what the user
 * overrode, and `resolveDuoConfig` is the single place those gaps are filled.
 */
export interface DuoSettings {
  /** Credential reference holding the `sk-airo-` key. */
  apiKeyEnv?: string;
  baseURL?: string;
  managementURL?: string;
  catalogTtlSeconds?: number;
  requestIdleTimeoutMs?: number;
  /** Timeout for a non-streaming InferHub read (catalogue, account). */
  requestTimeoutMs?: number;
  /** IANA timezone, or the `host` sentinel for this machine's timezone. */
  timezone?: string;
  defaultMaxTokens?: number;
  contextWindowFallback?: number;
  /** InferHub alias pinned by the `inferhub-orch` route. */
  orchestratorAlias?: string;
  /**
   * Ordered fallback aliases for the `inferhub-orch` route. When non-empty,
   * the route offers these in order and serves the first with capacity;
   * empty means the single `orchestratorAlias`.
   */
  orchestratorPool?: string[];
  /** Provider display name for the orchestrator route. */
  orchestratorLabel?: string;
  /** InferHub alias pinned by the `inferhub-sub` route. */
  subagentAlias?: string;
  /**
   * Ordered fallback aliases for the `inferhub-sub` route. When non-empty,
   * the route offers these in order and serves the first with capacity;
   * empty means the single `subagentAlias`.
   */
  subagentPool?: string[];
  /** Provider display name for the subagent route. */
  subagentLabel?: string;
  /**
   * Explicit ceilings for the orchestrator route. When set (any dimension),
   * the route runs `constrained` at these ceilings instead of floor-pinned
   * `cheapest`: use it when the live floor tier has no reliable capacity, to
   * admit backup tiers while still excluding the expensive tail.
   */
  orchestratorCeilings?: PriceCeilings;
  /** Explicit ceilings for the subagent route; same semantics as above. */
  subagentCeilings?: PriceCeilings;
  /**
   * Run the orchestrator route in `auto` mode: the bare alias with no price
   * headers, so InferHub walks cheapest-first and fails over to pricier tiers
   * when the floor has no capacity. Most resilient, least price-certain; the
   * local budgets remain the backstop. Overrides `orchestratorCeilings`.
   */
  orchestratorAuto?: boolean;
  /** Same, for the subagent route. Overrides `subagentCeilings`. */
  subagentAuto?: boolean;
  /**
   * Pin the orchestrator route to one upstream (`zai` → model id
   * `zai/<alias>`): only that provider ever serves, cheapest tier first
   * within it. Strongest quality guarantee, no cross-provider failover.
   * Overrides the auto flag; explicit ceilings still cap it.
   */
  orchestratorUpstream?: string;
  /** Same, for the subagent route. */
  subagentUpstream?: string;
  /**
   * Minimum accepted asks for the orchestrator route, per 1M tokens. Members
   * priced below either threshold are excluded from the route, so suspiciously
   * cheap tiers never serve even with free capacity. Never empties a route:
   * when every member is below the minimum, the minimum is not applied.
   */
  orchestratorMinAskInput?: number;
  /** Minimum accepted output ask for the orchestrator route, per 1M tokens. */
  orchestratorMinAskOutput?: number;
  /** Minimum accepted input ask for the subagent route, per 1M tokens. */
  subagentMinAskInput?: number;
  /** Minimum accepted output ask for the subagent route, per 1M tokens. */
  subagentMinAskOutput?: number;
  /** Upstream prefixes excluded from every route. */
  ignoreUpstreams?: string[];
  /** Default ceilings applied to every route. */
  ceilings?: PriceCeilings;
  /** Per-model ceiling overrides keyed by routable id or alias. */
  modelCeilings?: Record<string, PriceCeilings>;
  /** Local spending guard. */
  budgets?: {
    session?: number;
    daily?: number;
    monthly?: number;
    warnPercent?: number;
    enforce?: boolean;
  };
  /** Mirror ceilings to InferHub's stored per-model budgets (accepted for parity). */
  syncServerBudgets?: boolean;
  /** Provider retry policy. */
  retryPolicy?: RetryPolicyConfig;
}

/** Resolved duo configuration: every field has a value. */
export interface DuoConfig {
  apiKeyEnv: string;
  baseURL: string;
  managementURL: string;
  catalogTtlSeconds: number;
  requestIdleTimeoutMs: number;
  requestTimeoutMs: number;
  timezone: string;
  defaultMaxTokens: number;
  contextWindowFallback: number;
  orchestratorAlias: string;
  orchestratorPool: string[];
  orchestratorLabel: string;
  subagentAlias: string;
  subagentPool: string[];
  subagentLabel: string;
  orchestratorCeilings: PriceCeilings;
  subagentCeilings: PriceCeilings;
  orchestratorAuto: boolean;
  subagentAuto: boolean;
  orchestratorUpstream?: string;
  subagentUpstream?: string;
  orchestratorMinAskInput?: number;
  orchestratorMinAskOutput?: number;
  subagentMinAskInput?: number;
  subagentMinAskOutput?: number;
  ignoreUpstreams: string[];
  ceilings: PriceCeilings;
  modelCeilings: Record<string, PriceCeilings>;
  budgets: {
    session?: number;
    daily?: number;
    monthly?: number;
    warnPercent: number;
    enforce: boolean;
  };
  syncServerBudgets: boolean;
  retryPolicy?: RetryPolicyConfig;
}

/** Settings namespace this plugin owns. */
export const DUO_SETTINGS_NAMESPACE = 'inferhub-duo';
/** Default credential reference; the InferHub settings page writes this ref. */
export const DEFAULT_API_KEY_ENV = 'INFERHUB_API_KEY';
/** InferHub inference base. */
export const DEFAULT_BASE_URL = 'https://api.inferhub.dev';
/** InferHub management base. */
export const DEFAULT_MANAGEMENT_URL = 'https://inferhub.dev/api';
/** Minimum catalogue cache lifetime. */
export const MIN_CATALOG_TTL_SECONDS = 30;
/** Default catalogue cache lifetime. */
export const DEFAULT_CATALOG_TTL_SECONDS = 300;
/** Default idle watchdog for one streaming attempt. */
export const DEFAULT_REQUEST_IDLE_TIMEOUT_MS = 300_000;
/** Timeout for a non-streaming InferHub read (the catalogue and account surfaces). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
/** Sentinel meaning "resolve this host's IANA timezone". */
export const DEFAULT_TIMEZONE = 'host';
/** Default output cap materialized when a request names none. */
export const DEFAULT_MAX_TOKENS = 8192;
/** Context capacity assumed for models the catalogue does not size. */
export const DEFAULT_CONTEXT_WINDOW = 131_072;
/** Default orchestrator alias (InferHub's glm-5.3 member alias). */
export const DEFAULT_ORCHESTRATOR_ALIAS = 'glm-5.3';
/** Default orchestrator provider label. */
export const DEFAULT_ORCHESTRATOR_LABEL = 'InferHub Orchestrator';
/** Default subagent alias (InferHub's deepseek-v4.1-flash member alias). */
export const DEFAULT_SUBAGENT_ALIAS = 'deepseek-v4.1-flash';
/** Default subagent provider label. */
export const DEFAULT_SUBAGENT_LABEL = 'InferHub Subagent';
/** Profile id behind the `inferhub-orch` route. */
export const ORCHESTRATOR_PROFILE_ID = 'orch';
/** Profile id behind the `inferhub-sub` route. */
export const SUBAGENT_PROFILE_ID = 'sub';
/** Management API calls allowed per minute (the account bucket is 30/min shared with MCP). */
export const MANAGEMENT_CALLS_PER_MINUTE = 20;
/** Aliases accepted on the wire: lowercase, dot/dash/underscore separators. */
export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/** Upstream prefixes accepted on the wire: lowercase alphanumerics and dashes. */
export const UPSTREAM_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Default fraction of a budget limit at which a warning is surfaced. */
export const DEFAULT_WARN_PERCENT = 0.8;

const ceilingsSchema = z.object({
  input: z.number().min(0).description('Maximum input price per 1M tokens, in USDC (0 or unset = no ceiling)'),
  cachedInput: z
    .number()
    .min(0)
    .description('Advisory cached-input ceiling per 1M tokens (local check only; InferHub has no cache-price header)'),
  output: z.number().min(0).description('Maximum output price per 1M tokens, in USDC (0 or unset = no ceiling)'),
});

const budgetsSchema = z.object({
  session: z.number().min(0).description('Per-session spend limit in USDC (0 or unset = unlimited)'),
  daily: z.number().min(0).description('Per-local-day spend limit in USDC (0 or unset = unlimited)'),
  monthly: z.number().min(0).description('Per-local-month spend limit in USDC (0 or unset = unlimited)'),
  warnPercent: z.percent().description('Fraction of a limit at which a warning is surfaced (0.8 = 80%)'),
  enforce: z.boolean().description('Block a request that would exceed a limit instead of only warning'),
});

/**
 * User-facing configuration for the InferHub duo plugin.
 *
 * The annotation is the settings seam's contract: the stored section resolves to
 * {@link DuoSettings}, and `resolveDuoConfig` fills the defaults.
 */
export const Config: z<DuoSettings> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).description('Credential reference holding the InferHub `sk-airo-…` key'),
  baseURL: z.string().default(DEFAULT_BASE_URL).description('Inference base URL'),
  managementURL: z.string().default(DEFAULT_MANAGEMENT_URL).description('Management API base URL'),
  catalogTtlSeconds: z.natural().min(MIN_CATALOG_TTL_SECONDS).default(DEFAULT_CATALOG_TTL_SECONDS).description('Catalogue cache lifetime in seconds'),
  requestIdleTimeoutMs: z.natural().min(1000).default(DEFAULT_REQUEST_IDLE_TIMEOUT_MS).description('Maximum idle time between stream events before the attempt fails with TIMEOUT'),
  requestTimeoutMs: z.natural().min(1000).default(DEFAULT_REQUEST_TIMEOUT_MS).description('Timeout for a non-streaming InferHub read (catalogue, account); streaming uses the idle timeout'),
  timezone: z.string().default(DEFAULT_TIMEZONE).description('IANA timezone for daily/monthly spend buckets (default: this host)'),
  defaultMaxTokens: z.natural().min(1).default(DEFAULT_MAX_TOKENS).description('Output cap materialized when a request omits one'),
  contextWindowFallback: z.natural().min(1).default(DEFAULT_CONTEXT_WINDOW).description('Context capacity assumed for models the catalogue does not size'),
  orchestratorAlias: z.string().default(DEFAULT_ORCHESTRATOR_ALIAS).description('InferHub alias the `inferhub-orch` route pins; served at its live cheapest floor'),
  orchestratorPool: z.array(z.string()).default([]).description('Ordered fallback aliases for the orchestrator route; empty means the single orchestratorAlias'),
  orchestratorLabel: z.string().default(DEFAULT_ORCHESTRATOR_LABEL).description('Provider display name for the orchestrator route'),
  subagentAlias: z.string().default(DEFAULT_SUBAGENT_ALIAS).description('InferHub alias the `inferhub-sub` route pins; served at its live cheapest floor'),
  subagentPool: z.array(z.string()).default([]).description('Ordered fallback aliases for the subagent route; empty means the single subagentAlias'),
  subagentLabel: z.string().default(DEFAULT_SUBAGENT_LABEL).description('Provider display name for the subagent route'),
  orchestratorCeilings: ceilingsSchema.description('Explicit ceilings for the orchestrator route: when set, the route runs constrained at these instead of floor-pinned cheapest'),
  subagentCeilings: ceilingsSchema.description('Explicit ceilings for the subagent route: when set, the route runs constrained at these instead of floor-pinned cheapest'),
  orchestratorAuto: z.boolean().default(false).description('Run the orchestrator route in auto mode (bare alias, InferHub fails over to pricier tiers); overrides orchestratorCeilings'),
  subagentAuto: z.boolean().default(false).description('Run the subagent route in auto mode; overrides subagentCeilings'),
  orchestratorUpstream: z.string().default('').description('Pin the orchestrator route to one upstream prefix (zai serves zai/<alias> only); overrides the auto flag'),
  subagentUpstream: z.string().default('').description('Pin the subagent route to one upstream prefix; overrides the auto flag'),
  orchestratorMinAskInput: z.number().min(0).description('Minimum accepted input ask for the orchestrator route, per 1M tokens (0 or unset = no minimum)'),
  orchestratorMinAskOutput: z.number().min(0).description('Minimum accepted output ask for the orchestrator route, per 1M tokens (0 or unset = no minimum)'),
  subagentMinAskInput: z.number().min(0).description('Minimum accepted input ask for the subagent route, per 1M tokens (0 or unset = no minimum)'),
  subagentMinAskOutput: z.number().min(0).description('Minimum accepted output ask for the subagent route, per 1M tokens (0 or unset = no minimum)'),
  ignoreUpstreams: z.array(z.string()).default([]).description('Upstream prefixes excluded from every route'),
  ceilings: ceilingsSchema.description('Default ceilings applied to every route'),
  modelCeilings: z.dict(ceilingsSchema).description('Per-model ceiling overrides keyed by routable id or alias'),
  budgets: budgetsSchema.description('Local spending guard'),
  syncServerBudgets: z.boolean().default(false).description('Accepted for parity with dsh-inferhub; this v1 does not mirror ceilings to your account'),
  retryPolicy: RetryPolicySchema.description('Provider retry policy'),
});

/** Trim a stored string, falling back when it is missing or empty. */
function trimOr(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : fallback;
}

/** Drop non-finite, negative, and zero ceilings; zero means "no ceiling" upstream. */
export function sanitizeCeilings(input: PriceCeilings | undefined): PriceCeilings {
  if (input === undefined || input === null) return {};
  const clean: PriceCeilings = {};
  for (const key of ['input', 'cachedInput', 'output'] as const) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) clean[key] = value;
  }
  return clean;
}

/** Normalize upstream prefixes: trim, lowercase, strip a trailing slash, de-duplicate. */
function sanitizePrefixes(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim().toLowerCase().replace(/\/+$/, '');
    if (value.length > 0) seen.add(value);
  }
  return [...seen];
}

/** Normalize per-model ceiling overrides, dropping empty entries. */
function sanitizeModelCeilings(input: Record<string, PriceCeilings> | undefined): Record<string, PriceCeilings> {
  const clean: Record<string, PriceCeilings> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    const modelId = key.trim();
    if (modelId.length === 0) continue;
    const ceilings = sanitizeCeilings(value);
    if (Object.keys(ceilings).length > 0) clean[modelId] = ceilings;
  }
  return clean;
}

/** Resolve a stored timezone, treating the `host` sentinel or a bad value as this host. */
function resolveTimezone(raw: string | undefined): string {
  const value = raw?.trim();
  if (value !== undefined && value.length > 0 && value.toLowerCase() !== DEFAULT_TIMEZONE) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return value;
    } catch {
      // A bad stored timezone must not brick the plugin; fall through to this host.
    }
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Normalize one alias: lowercase, trim, and validate the wire shape. Anything
 * empty or malformed falls back to the default, so a bad edit never removes a
 * route's only model.
 */
export function normalizeAlias(raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim().toLowerCase();
  return ALIAS_PATTERN.test(value) ? value : fallback;
}

/**
 * Normalize one upstream prefix: lowercase, trim, and validate the wire
 * shape. Anything empty or malformed yields undefined (no pin) rather than a
 * route with no eligible models.
 */
export function normalizeUpstream(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim().toLowerCase().replace(/\/+$/, '');
  return UPSTREAM_PATTERN.test(value) ? value : undefined;
}

/** Normalize an ordered alias pool: lowercase, trim, keep the wire shape, de-duplicate. */
export function sanitizePool(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = (raw ?? '').trim().toLowerCase();
    if (value.length > 0 && ALIAS_PATTERN.test(value)) seen.add(value);
  }
  return [...seen];
}

/** Drop non-finite and non-positive minimum asks; zero means "no minimum". */
export function sanitizeMinAsk(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** One member model priced for minimum filtering. */
export interface MinFilterMember {
  /** Upstream prefix serving this member. */
  prefix: string;
  /** Exact routable id (used to match the alias by last segment). */
  id: string;
  minAskIn?: number;
  minAskOut?: number;
}

/**
 * Upstream prefixes to exclude because they serve the alias below the
 * minimum accepted asks.
 *
 * InferHub exposes no minimum-price header — ceilings only bound above — so a
 * floor is enforced by ignoring the upstreams that hold sub-minimum asks. A
 * prefix is excluded when its cheapest ask for this alias is below either
 * threshold; prefixes without ask data are always kept. When every member
 * would be excluded, nothing is excluded instead, so a minimum can never
 * empty a route on its own.
 * @param alias - bare alias the route serves.
 * @param minAskInput - minimum accepted input ask per 1M, if any.
 * @param minAskOutput - minimum accepted output ask per 1M, if any.
 * @param members - priced member rows for the alias.
 * @returns upstream prefixes to add to the route's ignored list.
 */
export function minViolatingPrefixes(
  alias: string,
  minAskInput: number | undefined,
  minAskOutput: number | undefined,
  members: readonly MinFilterMember[],
): string[] {
  if (minAskInput === undefined && minAskOutput === undefined) return [];
  const byPrefix = new Map<string, { minIn?: number; minOut?: number }>();
  for (const member of members) {
    const tail = member.id.includes('/') ? (member.id.split('/').pop() as string) : member.id;
    if (tail !== alias) continue;
    const known = byPrefix.get(member.prefix) ?? {};
    if (member.minAskIn !== undefined && (known.minIn === undefined || member.minAskIn < known.minIn)) known.minIn = member.minAskIn;
    if (member.minAskOut !== undefined && (known.minOut === undefined || member.minAskOut < known.minOut)) known.minOut = member.minAskOut;
    byPrefix.set(member.prefix, known);
  }
  if (byPrefix.size === 0) return [];
  const violators: string[] = [];
  for (const [prefix, asks] of byPrefix) {
    if (minAskInput !== undefined && asks.minIn !== undefined && asks.minIn < minAskInput) violators.push(prefix);
    else if (minAskOutput !== undefined && asks.minOut !== undefined && asks.minOut < minAskOutput) violators.push(prefix);
  }
  if (violators.length > 0 && violators.length >= byPrefix.size) return [];
  return violators;
}

/**
 * Normalize one stored duo configuration into validated facts.
 * @param raw - the resolved settings section (or the composition entry without a settings provider).
 * @returns a detached, validated configuration; every field has a value.
 */
export function resolveDuoConfig(raw: DuoSettings | undefined): DuoConfig {
  const stored = raw ?? {};
  const warnPercent = stored.budgets?.warnPercent;
  return {
    apiKeyEnv: trimOr(stored.apiKeyEnv, DEFAULT_API_KEY_ENV),
    baseURL: trimOr(stored.baseURL, DEFAULT_BASE_URL).replace(/\/+$/, ''),
    managementURL: trimOr(stored.managementURL, DEFAULT_MANAGEMENT_URL).replace(/\/+$/, ''),
    catalogTtlSeconds: Math.max(MIN_CATALOG_TTL_SECONDS, Math.floor(stored.catalogTtlSeconds ?? DEFAULT_CATALOG_TTL_SECONDS)),
    requestIdleTimeoutMs: Math.max(1000, Math.floor(stored.requestIdleTimeoutMs ?? DEFAULT_REQUEST_IDLE_TIMEOUT_MS)),
    requestTimeoutMs: Math.max(1000, Math.floor(stored.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)),
    timezone: resolveTimezone(stored.timezone),
    defaultMaxTokens: Math.max(1, Math.floor(stored.defaultMaxTokens ?? DEFAULT_MAX_TOKENS)),
    contextWindowFallback: Math.max(1, Math.floor(stored.contextWindowFallback ?? DEFAULT_CONTEXT_WINDOW)),
    orchestratorAlias: normalizeAlias(stored.orchestratorAlias, DEFAULT_ORCHESTRATOR_ALIAS),
    orchestratorPool: sanitizePool(stored.orchestratorPool),
    orchestratorLabel: trimOr(stored.orchestratorLabel, DEFAULT_ORCHESTRATOR_LABEL),
    subagentAlias: normalizeAlias(stored.subagentAlias, DEFAULT_SUBAGENT_ALIAS),
    subagentPool: sanitizePool(stored.subagentPool),
    subagentLabel: trimOr(stored.subagentLabel, DEFAULT_SUBAGENT_LABEL),
    orchestratorCeilings: sanitizeCeilings(stored.orchestratorCeilings),
    subagentCeilings: sanitizeCeilings(stored.subagentCeilings),
    orchestratorAuto: stored.orchestratorAuto === true,
    subagentAuto: stored.subagentAuto === true,
    orchestratorUpstream: normalizeUpstream(stored.orchestratorUpstream),
    subagentUpstream: normalizeUpstream(stored.subagentUpstream),
    orchestratorMinAskInput: sanitizeMinAsk(stored.orchestratorMinAskInput),
    orchestratorMinAskOutput: sanitizeMinAsk(stored.orchestratorMinAskOutput),
    subagentMinAskInput: sanitizeMinAsk(stored.subagentMinAskInput),
    subagentMinAskOutput: sanitizeMinAsk(stored.subagentMinAskOutput),
    ignoreUpstreams: sanitizePrefixes(stored.ignoreUpstreams),
    ceilings: sanitizeCeilings(stored.ceilings),
    modelCeilings: sanitizeModelCeilings(stored.modelCeilings),
    budgets: {
      ...(typeof stored.budgets?.session === 'number' && stored.budgets.session > 0 ? { session: stored.budgets.session } : {}),
      ...(typeof stored.budgets?.daily === 'number' && stored.budgets.daily > 0 ? { daily: stored.budgets.daily } : {}),
      ...(typeof stored.budgets?.monthly === 'number' && stored.budgets.monthly > 0 ? { monthly: stored.budgets.monthly } : {}),
      warnPercent: typeof warnPercent === 'number' && Number.isFinite(warnPercent) ? Math.min(1, Math.max(0.05, warnPercent)) : DEFAULT_WARN_PERCENT,
      enforce: stored.budgets?.enforce !== false,
    },
    syncServerBudgets: stored.syncServerBudgets === true,
    ...(stored.retryPolicy === undefined ? {} : { retryPolicy: stored.retryPolicy }),
  };
}

/**
 * Map resolved duo settings onto the dsh-inferhub runtime's settings shape.
 *
 * Each route serves one alias or, when set, an ordered pool of aliases. An
 * upstream pin turns the route into `upstream` mode (`<prefix>/<alias>`, only
 * that provider serves); otherwise the auto flag selects `auto` (bare alias,
 * InferHub fails over by itself), explicit ceilings select `constrained`, and
 * the default is `cheapest` (ceilings pinned to the live floor).
 */
export function toInferHubSettings(duo: DuoConfig): InferHubSettings {
  const route = (
    id: string,
    label: string,
    alias: string,
    pool: readonly string[],
    ceilings: PriceCeilings,
    auto: boolean,
    upstream: string | undefined,
  ): RoutingProfileSetting => {
    const ids = pool.length > 0 ? [...pool] : [alias];
    if (upstream !== undefined) {
      return {
        id,
        label,
        mode: 'upstream',
        upstream,
        modelIds: ids.map((model) => `${upstream}/${model}`),
        ...(Object.keys(ceilings).length > 0 ? { ceilings } : {}),
        enabled: true,
      };
    }
    if (auto) return { id, label, mode: 'auto', modelIds: ids, enabled: true };
    return Object.keys(ceilings).length > 0
      ? { id, label, mode: 'constrained', modelIds: ids, ceilings, enabled: true }
      : { id, label, mode: 'cheapest', modelIds: ids, enabled: true };
  };
  const routingProfiles: RoutingProfileSetting[] = [
    route(ORCHESTRATOR_PROFILE_ID, duo.orchestratorLabel, duo.orchestratorAlias, duo.orchestratorPool, duo.orchestratorCeilings, duo.orchestratorAuto, duo.orchestratorUpstream),
    route(SUBAGENT_PROFILE_ID, duo.subagentLabel, duo.subagentAlias, duo.subagentPool, duo.subagentCeilings, duo.subagentAuto, duo.subagentUpstream),
  ];
  return {
    apiKeyEnv: duo.apiKeyEnv,
    baseURL: duo.baseURL,
    managementURL: duo.managementURL,
    catalogTtlSeconds: duo.catalogTtlSeconds,
    requestIdleTimeoutMs: duo.requestIdleTimeoutMs,
    requestTimeoutMs: duo.requestTimeoutMs,
    timezone: duo.timezone,
    defaultMaxTokens: duo.defaultMaxTokens,
    contextWindowFallback: duo.contextWindowFallback,
    upstreamRoutes: 'off',
    ignoreUpstreams: duo.ignoreUpstreams,
    routingProfiles,
    ceilings: duo.ceilings,
    modelCeilings: duo.modelCeilings,
    budgets: duo.budgets,
    syncServerBudgets: duo.syncServerBudgets,
    ...(duo.retryPolicy === undefined ? {} : { retryPolicy: duo.retryPolicy }),
  };
}
