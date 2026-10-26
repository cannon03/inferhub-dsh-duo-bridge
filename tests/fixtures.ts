/**
 * Shared test fixtures: a realistic InferHub catalogue for the duo plugin.
 *
 * The numbers mirror InferHub's documented wire shape so normalization
 * exercises the same structure the live catalogue returns. Floors:
 * - `glm-5.3` routes across CodeBuddy and Z.AI; Z.AI's ask is the floor
 *   (in $0.0014/M, out $0.0044/M);
 * - `deepseek-v4.1-flash` routes across CodeBuddy and CodeBuddy CN; CodeBuddy
 *   CN's ask is the floor (in $0.0025/M, out $0.01/M).
 *
 * @module dsh-inferhub-duo/tests/fixtures
 */
import type { CatalogSnapshot, InferHubSettings } from '../src/runtime.ts';
import { resolveInferHubConfig } from '../src/runtime.ts';
import { toInferHubSettings, resolveDuoConfig } from '../src/duo-config.ts';

/** Raw `/v1/models` entries: two aliases plus their member models. */
export const wireModels = [
  {
    // Live shape: an `owned_by: "alias"` row carries NO pricing object, so the
    // floor for the alias has to be derived from the members it routes across.
    id: 'glm-5.3',
    owned_by: 'alias',
    modality: 'text',
    output_modality: 'text',
    supports_cache: false,
  },
  {
    id: 'deepseek-v4.1-flash',
    owned_by: 'alias',
    modality: 'text',
    output_modality: 'text',
    supports_cache: true,
    reasoning_levels: ['low', 'high'],
  },
  {
    id: 'kimi-k3.1-pro',
    owned_by: 'alias',
    modality: 'text',
    output_modality: 'text',
    supports_cache: false,
  },
  {
    id: 'cb/kimi-k3.1-pro',
    owned_by: 'cb',
    upstream_label: 'CodeBuddy',
    modality: 'text',
    output_modality: 'text',
    input_token_limit: 262144,
    max_output_tokens: 32768,
    supports_cache: false,
    pricing: { official_in: 2, official_out: 10, asks_in: [0.016], asks_out: [0.08] },
  },
  {
    id: 'cb/glm-5.3',
    owned_by: 'cb',
    upstream_label: 'CodeBuddy',
    modality: 'text',
    output_modality: 'text',
    input_token_limit: 200000,
    max_output_tokens: 32000,
    supports_cache: false,
    pricing: { official_in: 1.4, official_out: 4.4, asks_in: [0.02], asks_out: [0.08] },
  },
  {
    id: 'zai/glm-5.3',
    owned_by: 'zai',
    upstream_label: 'Z.AI',
    modality: 'text',
    output_modality: 'text',
    input_token_limit: 200000,
    max_output_tokens: 32000,
    supports_cache: false,
    pricing: { official_in: 1.4, official_out: 4.4, asks_in: [0.0014], asks_out: [0.0044] },
  },
  {
    id: 'cb/deepseek-v4.1-flash',
    owned_by: 'cb',
    upstream_label: 'CodeBuddy',
    modality: 'text',
    output_modality: 'text',
    input_token_limit: 131072,
    max_output_tokens: 8192,
    supports_cache: true,
    pricing: { official_in: 0.15, official_out: 0.6, asks_in: [0.00015], asks_out: [0.0006] },
  },
  {
    id: 'cbcn/deepseek-v4.1-flash',
    owned_by: 'cbcn',
    upstream_label: 'CodeBuddy CN',
    modality: 'text',
    output_modality: 'text',
    pricing: { official_in: 0.15, official_out: 0.6, asks_in: [0.0025], asks_out: [0.01] },
  },
];

/** Raw `/catalog` upstream cards. */
export const wireCatalog = [
  {
    id: 'up-cb',
    slug: 'cb',
    prefix: 'cb',
    label: 'CodeBuddy',
    status: 'available',
    enabled: true,
    activeProviders: 3,
    models: [
      {
        id: 'cm-cb-glm53',
        upstreamModelId: 'glm-5.3',
        label: 'GLM 5.3',
        officialIn: 1.4,
        officialOut: 4.4,
        pricePointsIn: [[0.02, 12]],
        pricePointsOut: [[0.08, 12]],
        enabled: true,
        supportsCache: false,
        contextWindow: 200000,
        maxOutputTokens: 32000,
        outputModality: 'text',
      },
      {
        id: 'cm-cb-flash',
        upstreamModelId: 'deepseek-v4.1-flash',
        label: 'DeepSeek V4.1 Flash',
        officialIn: 0.15,
        officialOut: 0.6,
        pricePointsIn: [[0.00015, 12]],
        pricePointsOut: [[0.0006, 12]],
        reasoningLevels: ['low', 'high', 'max'],
        enabled: true,
        supportsCache: true,
        contextWindow: 131072,
        maxOutputTokens: 8192,
        outputModality: 'text',
      },
      {
        id: 'cm-cb-kimi',
        upstreamModelId: 'kimi-k3.1-pro',
        label: 'Kimi K3.1 Pro',
        officialIn: 2,
        officialOut: 10,
        pricePointsIn: [[0.016, 8]],
        pricePointsOut: [[0.08, 8]],
        enabled: true,
        supportsCache: false,
        contextWindow: 262144,
        maxOutputTokens: 32768,
        outputModality: 'text',
      },
    ],
  },
  {
    id: 'up-zai',
    slug: 'zai',
    prefix: 'zai',
    label: 'Z.AI',
    status: 'available',
    enabled: true,
    activeProviders: 2,
    models: [
      {
        id: 'cm-zai-glm53',
        upstreamModelId: 'glm-5.3',
        label: 'GLM 5.3',
        officialIn: 1.4,
        officialOut: 4.4,
        pricePointsIn: [[0.0014, 5]],
        pricePointsOut: [[0.0044, 5]],
        enabled: true,
        supportsCache: false,
        contextWindow: 200000,
        maxOutputTokens: 32000,
        outputModality: 'text',
      },
    ],
  },
  {
    id: 'up-cbcn',
    slug: 'cbcn',
    prefix: 'cbcn',
    label: 'CodeBuddy CN',
    status: 'available',
    enabled: true,
    activeProviders: 1,
    models: [
      {
        id: 'cm-cbcn-flash',
        upstreamModelId: 'deepseek-v4.1-flash',
        label: 'DeepSeek V4.1 Flash',
        officialIn: 0.15,
        officialOut: 0.6,
        pricePointsIn: [[0.0025, 4]],
        pricePointsOut: [[0.01, 4]],
        reasoningLevels: ['low', 'high'],
        enabled: true,
        outputModality: 'text',
      },
    ],
  },
];

/** Raw `/combos` entries. */
export const wireCombos: { id: string; name: string; slug: string }[] = [];

/** Raw `/budgets/aliases` entries. */
export const wireAliasBudgets = [
  {
    alias: 'glm-5.3',
    label: 'GLM 5.3',
    isAlias: true,
    memberModelIds: ['cm-cb-glm53', 'cm-zai-glm53'],
    memberCount: 2,
  },
  {
    alias: 'deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    isAlias: true,
    memberModelIds: ['cm-cb-flash', 'cm-cbcn-flash'],
    memberCount: 2,
  },
  {
    alias: 'kimi-k3.1-pro',
    label: 'Kimi K3.1 Pro',
    isAlias: true,
    memberModelIds: ['cm-cb-kimi'],
    memberCount: 1,
  },
];

/** Raw `/v1/me/usage` payload. */
export const wireAccount = {
  currency: 'USDC',
  balance: { amount_usdc: 12.5 },
  window: { spend_usdc: 0.42, requests: 17 },
  all_time: { spend_usdc: 31.1, requests: 1204 },
};

/** The runtime settings the default duo configuration maps onto. */
export function testSettings(): InferHubSettings {
  return toInferHubSettings(resolveDuoConfig({}));
}

/** A resolved runtime configuration for the default duo settings. */
export function testConfig() {
  return resolveInferHubConfig(testSettings());
}

/** Build a normalized snapshot directly, for tests that do not need the HTTP client. */
export async function testSnapshot(): Promise<CatalogSnapshot> {
  const { normalizeAliases, normalizeModels, normalizeUpstreams, normalizeAccountUsage } = await import(
    '../node_modules/dsh-inferhub/lib/catalog.js'
  );
  const upstreams = normalizeUpstreams(wireCatalog);
  const aliases = normalizeAliases(wireAliasBudgets, upstreams);
  const models = normalizeModels(wireModels, upstreams, aliases.members, aliases.labels);
  return {
    fetchedAt: Date.now(),
    upstreams,
    models,
    combos: [],
    aliasMembers: aliases.members,
    account: normalizeAccountUsage(wireAccount, Date.now()),
    stale: false,
  };
}
