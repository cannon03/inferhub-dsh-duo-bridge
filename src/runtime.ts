/**
 * Single seam onto the dsh-inferhub runtime in the sibling checkout.
 *
 * dsh-inferhub publishes only its root entry through `exports`, so its routing
 * helpers, config resolver, and HTTP helpers are reached through the built lib
 * path of the `file:` dependency. TypeScript shapes are declared locally in
 * this file (mirroring dsh-inferhub's `src/types.ts`) instead of importing the
 * sibling's sources: importing `../../dsh-inferhub/src/*.ts` would pull the
 * sibling's whole program — and its harness-linked modules — into this
 * package's typecheck. Keeping every such path here means the dependency's
 * layout is described in exactly one place.
 *
 * @module dsh-inferhub-duo/runtime
 */
import {
  CatalogService as CatalogServiceImpl,
  SpendLedger as SpendLedgerImpl,
  InferHubAdapter as InferHubAdapterImpl,
  InferHubClient as InferHubClientImpl,
} from 'dsh-inferhub';
import {
  deriveRoutes as deriveRoutesImpl,
  indexRoutes as indexRoutesImpl,
  describeRoute as describeRouteImpl,
} from '../node_modules/dsh-inferhub/lib/routing.js';
import { retryPolicyOf as retryPolicyOfImpl } from '../node_modules/dsh-inferhub/lib/adapter.js';
import { describe as describeImpl } from '../node_modules/dsh-inferhub/lib/catalog.js';
import { resolveConfig as resolveInferHubConfigImpl } from '../node_modules/dsh-inferhub/lib/config.js';
import {
  rejected as rejectedImpl,
  sendJson as sendJsonImpl,
  sendMethodNotAllowed as sendMethodNotAllowedImpl,
} from '../node_modules/dsh-inferhub/lib/routes.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- thin glue over built JS; behaviour is pinned by integration tests. */
/** Re-exported runtime helpers, typed loosely: the built JS carries no declarations. */
export const CatalogService: any = CatalogServiceImpl;
export const SpendLedger: any = SpendLedgerImpl;
export const InferHubAdapter: any = InferHubAdapterImpl;
export const InferHubClient: any = InferHubClientImpl;
export const deriveRoutes: (...args: any[]) => any = deriveRoutesImpl;
export const indexRoutes: (...args: any[]) => any = indexRoutesImpl;
export const describeRoute: (...args: any[]) => any = describeRouteImpl;
export const retryPolicyOf: (...args: any[]) => any = retryPolicyOfImpl;
export const describe: (...args: any[]) => any = describeImpl;
export const resolveInferHubConfig: (...args: any[]) => any = resolveInferHubConfigImpl;
export const rejected: (...args: any[]) => any = rejectedImpl;
export const sendJson: (...args: any[]) => any = sendJsonImpl;
export const sendMethodNotAllowed: (...args: any[]) => any = sendMethodNotAllowedImpl;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** How one route asks InferHub to pick capacity. */
export type RoutingMode = 'auto' | 'cheapest' | 'constrained' | 'upstream' | 'combo' | 'free';

/** Maximum accepted price per 1M tokens, in USDC. A missing value means "no ceiling". */
export interface PriceCeilings {
  /** Ceiling for uncached input tokens. Sent as `x-max-input-price`. */
  input?: number;
  /**
   * Ceiling for cached input tokens. InferHub exposes no cache-price header, so
   * this is an advisory local admission check.
   */
  cachedInput?: number;
  /** Ceiling for output tokens. Sent as `x-max-output-price`. */
  output?: number;
}

/**
 * Reasoning-effort ids the adapter offers or sends. The first seven are the
 * vocabulary InferHub's catalogue advertises; CodeBuddy also accepts `off`.
 */
export type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'off';

/** One reusable model + routing + price-constraint configuration. */
export interface RoutingProfile {
  /** Slug selecting the provider route id `inferhub-<id>`. */
  id: string;
  /** Display name shown as the provider in the model picker. */
  label: string;
  mode: RoutingMode;
  /** Upstream prefix for `mode: 'upstream'`. */
  upstream?: string;
  /** Optional allow-list of routable InferHub ids / aliases. Empty means every eligible model. */
  modelIds?: string[];
  /** Effort levels offered for models that advertise none. */
  fallbackReasoningLevels?: ReasoningLevel[];
  /** Profile-scoped ceilings, overriding the plugin defaults. */
  ceilings?: PriceCeilings;
  /** Upstream prefixes dropped from this profile via `x-ignore-upstream`. */
  ignoreUpstreams?: string[];
  /** Disabled profiles keep their stored shape but register no route. */
  enabled?: boolean;
}

/** One stored routing-profile entry (the loose settings shape). */
export interface RoutingProfileSetting {
  id?: string;
  label?: string;
  mode?: RoutingMode;
  upstream?: string;
  modelIds?: string[];
  fallbackReasoningLevels?: ReasoningLevel[];
  ceilings?: PriceCeilings;
  ignoreUpstreams?: string[];
  enabled?: boolean;
}

/** Stored InferHub settings — the settings-namespace schema shape (all-optional). */
export interface InferHubSettings {
  apiKeyEnv?: string;
  baseURL?: string;
  managementURL?: string;
  catalogTtlSeconds?: number;
  requestIdleTimeoutMs?: number;
  requestTimeoutMs?: number;
  timezone?: string;
  defaultMaxTokens?: number;
  contextWindowFallback?: number;
  upstreamRoutes?: 'auto' | 'off';
  ignoreUpstreams?: string[];
  routingProfiles?: RoutingProfileSetting[];
  ceilings?: PriceCeilings;
  modelCeilings?: Record<string, PriceCeilings>;
  budgets?: {
    session?: number;
    daily?: number;
    monthly?: number;
    warnPercent?: number;
    enforce?: boolean;
  };
  syncServerBudgets?: boolean;
  retryPolicy?: unknown;
}

/** Local spending guard limits, in USDC. */
export interface BudgetLimits {
  session?: number;
  daily?: number;
  monthly?: number;
  warnPercent: number;
  enforce: boolean;
}

/** Resolved plugin configuration (normalized). */
export interface InferHubConfig {
  apiKeyEnv: string;
  baseURL: string;
  managementURL: string;
  catalogTtlSeconds: number;
  requestIdleTimeoutMs: number;
  requestTimeoutMs: number;
  timezone: string;
  defaultMaxTokens: number;
  contextWindowFallback: number;
  upstreamRoutes: 'auto' | 'off';
  ignoreUpstreams: string[];
  routingProfiles: RoutingProfile[];
  ceilings: PriceCeilings;
  modelCeilings: Record<string, PriceCeilings>;
  budgets: BudgetLimits;
  syncServerBudgets: boolean;
  retryPolicy?: unknown;
}

/** Account balance and spend as InferHub reports it. */
export interface AccountUsage {
  balance?: number;
  currency: string;
  daySpend?: number;
  monthSpend?: number;
  allTimeSpend?: number;
  requests?: number;
  fetchedAt: number;
}

/** One normalized catalogue snapshot shared by route derivation and the UI. */
export interface CatalogSnapshot {
  fetchedAt: number;
  upstreams: unknown[];
  models: unknown[];
  combos: unknown[];
  aliasMembers: Record<string, string[]>;
  account?: AccountUsage;
  /** True when the snapshot is a cached one served after a failed refresh. */
  stale: boolean;
  /** Last refresh failure, kept beside the cached data. */
  error?: string;
}

/** One model offered by a derived route. */
export interface RouteModel {
  /** Exact id sent to InferHub. */
  id: string;
  /** Picker label. */
  name: string;
  /** Picker description: mode, provider count, live price, ceiling. */
  description: string;
  /** Ceilings this exact model is requested under. */
  ceilings: PriceCeilings;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningLevels: string[];
  /** True when the levels come from a profile fallback, not from the catalogue. */
  reasoningAssumed?: boolean;
  supportsCache: boolean;
}

/** One derived provider route. */
export interface RouteSpec {
  /** Provider route id registered with the DSH LLM service. */
  route: string;
  /** Provider display name shown by the model picker. */
  displayName: string;
  mode: RoutingMode;
  /** Upstream prefix when the route is pinned. */
  upstream?: string;
  profileId?: string;
  ceilings: PriceCeilings;
  ignoreUpstreams: string[];
  models: RouteModel[];
  /** True when the route has no eligible models in the current catalogue. */
  empty: boolean;
}

/** Effective per-request routing facts resolved for one route. */
export interface RouteFacts {
  route: string;
  displayName: string;
  mode: RoutingMode;
  ceilings: PriceCeilings;
  ignoreUpstreams: string[];
  /** Models by exact id. */
  models: Map<string, RouteModel>;
}

/** One frozen adapter generation: routes plus the configuration that produced them. */
export interface AdapterGeneration {
  routes: Map<string, RouteFacts>;
  config: InferHubConfig;
}
