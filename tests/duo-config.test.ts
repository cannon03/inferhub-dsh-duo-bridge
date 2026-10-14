/**
 * Unit tests for the duo configuration: defaults, alias normalization, and the
 * mapping onto the dsh-inferhub runtime settings.
 *
 * @module dsh-inferhub-duo/tests/duo-config
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORCHESTRATOR_ALIAS,
  DEFAULT_SUBAGENT_ALIAS,
  minViolatingPrefixes,
  normalizeAlias,
  resolveDuoConfig,
  toInferHubSettings,
} from '../src/duo-config.ts';
import type { MinFilterMember } from '../src/duo-config.ts';

describe('resolveDuoConfig', () => {
  it('seeds the glm-5.3 orchestrator and the deepseek-v4.1-flash subagent', () => {
    const config = resolveDuoConfig({});
    expect(config.orchestratorAlias).toBe(DEFAULT_ORCHESTRATOR_ALIAS);
    expect(config.subagentAlias).toBe(DEFAULT_SUBAGENT_ALIAS);
    expect(config.orchestratorAlias).toBe('glm-5.3');
    expect(config.subagentAlias).toBe('deepseek-v4.1-flash');
    expect(config.orchestratorLabel).toBe('InferHub Orchestrator');
    expect(config.subagentLabel).toBe('InferHub Subagent');
  });

  it('fills transport and guard defaults', () => {
    const config = resolveDuoConfig({});
    expect(config.apiKeyEnv).toBe('INFERHUB_API_KEY');
    expect(config.baseURL).toBe('https://api.inferhub.dev');
    expect(config.managementURL).toBe('https://inferhub.dev/api');
    expect(config.catalogTtlSeconds).toBe(300);
    expect(config.budgets).toMatchObject({ warnPercent: 0.8, enforce: true });
    expect(config.syncServerBudgets).toBe(false);
  });

  it('clamps a too-small catalogue TTL instead of bricking the plugin', () => {
    expect(resolveDuoConfig({ catalogTtlSeconds: 5 }).catalogTtlSeconds).toBe(30);
  });

  it('falls back to this host for a bad timezone', () => {
    const config = resolveDuoConfig({ timezone: 'not/a-zone' });
    expect(config.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  });
});

describe('normalizeAlias', () => {
  it('trims and lowercases', () => {
    expect(normalizeAlias('  GLM-5.3  ', 'glm-5.3')).toBe('glm-5.3');
  });

  it('falls back on empty or malformed values', () => {
    expect(normalizeAlias(undefined, 'glm-5.3')).toBe('glm-5.3');
    expect(normalizeAlias('', 'glm-5.3')).toBe('glm-5.3');
    expect(normalizeAlias('has space', 'glm-5.3')).toBe('glm-5.3');
    expect(normalizeAlias('upstream/model', 'glm-5.3')).toBe('glm-5.3');
  });
});

describe('toInferHubSettings', () => {
  it('maps onto exactly two cheapest profiles with per-upstream routes off', () => {
    const settings = toInferHubSettings(resolveDuoConfig({}));
    expect(settings.upstreamRoutes).toBe('off');
    expect(settings.routingProfiles).toEqual([
      { id: 'orch', label: 'InferHub Orchestrator', mode: 'cheapest', modelIds: ['glm-5.3'], enabled: true },
      { id: 'sub', label: 'InferHub Subagent', mode: 'cheapest', modelIds: ['deepseek-v4.1-flash'], enabled: true },
    ]);
  });

  it('carries custom aliases and labels through', () => {
    const settings = toInferHubSettings(
      resolveDuoConfig({ orchestratorAlias: 'glm-5.2', orchestratorLabel: 'Planner', subagentAlias: 'glm-5.3' }),
    );
    expect(settings.routingProfiles?.[0]).toMatchObject({ id: 'orch', label: 'Planner', mode: 'cheapest', modelIds: ['glm-5.2'] });
    expect(settings.routingProfiles?.[1]).toMatchObject({ id: 'sub', mode: 'cheapest', modelIds: ['glm-5.3'] });
  });

  it('runs a route constrained at explicit ceilings instead of floor-pinned cheapest', () => {
    const settings = toInferHubSettings(resolveDuoConfig({ orchestratorCeilings: { input: 0.025, output: 0.08 } }));
    expect(settings.routingProfiles?.[0]).toMatchObject({
      id: 'orch',
      mode: 'constrained',
      modelIds: ['glm-5.3'],
      ceilings: { input: 0.025, output: 0.08 },
    });
    // The untouched route stays cheapest.
    expect(settings.routingProfiles?.[1]).toMatchObject({ id: 'sub', mode: 'cheapest' });
  });

  it('drops empty and non-positive explicit ceilings back to cheapest', () => {
    const settings = toInferHubSettings(resolveDuoConfig({ orchestratorCeilings: { input: 0 } }));
    expect(settings.routingProfiles?.[0]).toMatchObject({ id: 'orch', mode: 'cheapest' });
  });

  it('runs a route in auto mode when the auto flag is set, overriding ceilings', () => {
    const settings = toInferHubSettings(
      resolveDuoConfig({ orchestratorAuto: true, orchestratorCeilings: { input: 0.025, output: 0.08 } }),
    );
    expect(settings.routingProfiles?.[0]).toEqual({
      id: 'orch',
      label: 'InferHub Orchestrator',
      mode: 'auto',
      modelIds: ['glm-5.3'],
      enabled: true,
    });
    expect(settings.routingProfiles?.[1]).toMatchObject({ id: 'sub', mode: 'cheapest' });
  });

  it('pins a route to one upstream, overriding the auto flag and ceilings', () => {
    const settings = toInferHubSettings(
      resolveDuoConfig({
        orchestratorUpstream: ' ZAI/ ',
        orchestratorAuto: true,
        orchestratorCeilings: { input: 0.025, output: 0.08 },
      }),
    );
    expect(settings.routingProfiles?.[0]).toEqual({
      id: 'orch',
      label: 'InferHub Orchestrator',
      mode: 'upstream',
      upstream: 'zai',
      modelIds: ['zai/glm-5.3'],
      ceilings: { input: 0.025, output: 0.08 },
      enabled: true,
    });
  });

  it('drops a malformed upstream pin back to the alias modes', () => {
    const settings = toInferHubSettings(resolveDuoConfig({ orchestratorUpstream: 'has space!' }));
    expect(settings.routingProfiles?.[0]).toMatchObject({ id: 'orch', mode: 'cheapest', modelIds: ['glm-5.3'] });
  });

  it('resolves per-route minimum asks, dropping non-positive values', () => {
    const config = resolveDuoConfig({ subagentMinAskInput: 0.01, subagentMinAskOutput: 0.04 });
    expect(config.subagentMinAskInput).toBe(0.01);
    expect(config.subagentMinAskOutput).toBe(0.04);
    expect(config.orchestratorMinAskInput).toBeUndefined();
    expect(resolveDuoConfig({ subagentMinAskInput: 0 }).subagentMinAskInput).toBeUndefined();
  });
});

describe('minViolatingPrefixes', () => {
  const members: MinFilterMember[] = [
    { prefix: 'zai', id: 'zai/glm-5.3', minAskIn: 0.0014, minAskOut: 0.0044 },
    { prefix: 'cb', id: 'cb/glm-5.3', minAskIn: 0.0182, minAskOut: 0.0572 },
    { prefix: 'cbcn', id: 'cbcn/glm-5.3', minAskIn: 0.0224, minAskOut: 0.0704 },
  ];

  it('returns nothing when no minimum is set', () => {
    expect(minViolatingPrefixes('glm-5.3', undefined, undefined, members)).toEqual([]);
  });

  it('bans prefixes below either threshold', () => {
    expect(minViolatingPrefixes('glm-5.3', 0.01, 0.01, members)).toEqual(['zai']);
    expect(minViolatingPrefixes('glm-5.3', 0.02, undefined, members)).toEqual(['zai', 'cb']);
  });

  it('ignores other aliases and prefixes without ask data', () => {
    const extra: MinFilterMember[] = [
      ...members,
      { prefix: 'mystery', id: 'mystery/glm-5.3' },
      { prefix: 'cb', id: 'cb/other-model', minAskIn: 0.00001, minAskOut: 0.00001 },
    ];
    expect(minViolatingPrefixes('glm-5.3', 0.01, 0.01, extra)).toEqual(['zai']);
  });

  it('never bans every member', () => {
    expect(minViolatingPrefixes('glm-5.3', 99, 99, members)).toEqual([]);
  });
});
