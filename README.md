# dsh-inferhub-duo

Two **cheapest** InferHub routes for DeepSeek Harness: one for the
orchestrator, one for the subagent. Each route pins a single configurable
InferHub alias and serves it at its live cheapest floor — nothing else is
eligible, so a pricier fallback is refused instead of silently charged.

```
InferHub Orchestrator  →  GLM 5.3              (cheapest floor: in $0.0014/M out $0.0044/M)
InferHub Subagent      →  DeepSeek V4.1 Flash  (cheapest floor: in $0.00015/M out $0.0006/M)
```

Both routes run the same `cheapest` machinery as `dsh-inferhub` (whose
catalogue, routing, adapter, and ledger modules are reused untouched via the
`file:../dsh-inferhub` dependency): the bare alias id is sent with
`x-max-input-price` / `x-max-output-price` pinned to that model's live
cheapest ask. Floors move with the market — the plugin re-pins on every
catalogue refresh.

## Install

```bash
# from the plugin checkout
npm install          # dev dependencies + the sibling dsh-inferhub checkout
npm run link-dsh     # symlink @deepseek-ai/* from the harness anchor (single-instance rule)
npm run build        # tsc → lib/*.js
npm test             # 16 tests: config mapping + boot integration vs a mock InferHub

# into the web profile (NOT enabled yet — say the word and I'll add it)
dsh plugin --profile web add /home/developer/projects/typescript/dsh-inferhub-duo
```

`dsh plugin --profile <name> …` reconciles profile bundles from this
package's `dsh.bundle.patch` (`cordis.patch.yml`), which inserts the
`dsh-inferhub-duo` plugin into the composition.

### The single-instance rule

`@deepseek-ai/*` packages are **never** declared as dependencies: the plugin
must resolve the harness's own copies so `instanceof` and cordis service
identity hold. `npm run link-dsh` creates
`node_modules/@deepseek-ai/<pkg>` symlinks pointing at the harness anchor,
and `pnpm-workspace.yaml` pins `autoInstallPeers: false` so a registry copy
is never pulled in. Re-run `npm run link-dsh` after any `npm install`.

### The peer-declaration rule

Every `@deepseek-ai/*` package imported at runtime **must** be declared in
`peerDependencies` — including transitive ones reached through the
`file:../dsh-inferhub` dependency (`dsh-llm`, `dsh-credentials`,
`dsh-home-paths`, `dsh-atomic-write`, `schemastery`). The host only
intercepts a bare import to its own copy when an ancestor `package.json`
peer-depends on it; otherwise the import falls through to native resolution
and the plugin fails to load with no fiber. `dshmarket` follows the same
contract.

### Credentials

Same seam as `dsh-inferhub`: the plugin reads the credential reference in
`apiKeyEnv` (default `INFERHUB_API_KEY`) through the harness credential
service, falling back to the ambient environment. Set it in the harness UI
or export it; a missing key fails the picker with an actionable
`CATALOG_UNAVAILABLE` message instead of an empty list.

## Configuration

Everything lives in the `inferhub-duo` settings namespace. Every field is
optional; the resolved defaults are below.

| Field | Default | Meaning |
| --- | --- | --- |
| `orchestratorAlias` | `glm-5.3` | InferHub alias the `inferhub-orch` route serves |
| `orchestratorLabel` | `InferHub Orchestrator` | Picker group name for the orchestrator route |
| `subagentAlias` | `deepseek-v4.1-flash` | InferHub alias the `inferhub-sub` route serves |
| `subagentLabel` | `InferHub Subagent` | Picker group name for the subagent route |
| `orchestratorCeilings` | `{}` (cheapest) | Explicit ceilings for the orchestrator route: when set, the route runs `constrained` at these instead of floor-pinned `cheapest` |
| `subagentCeilings` | `{}` (cheapest) | Same, for the subagent route |
| `orchestratorAuto` | `false` | Run the orchestrator route in `auto` (bare alias, InferHub fails over by itself); overrides ceilings |
| `subagentAuto` | `false` | Same, for the subagent route |
| `orchestratorUpstream` | unset | Pin the orchestrator route to one upstream (`zai` serves `zai/<alias>` only); overrides the auto flag |
| `subagentUpstream` | unset | Same, for the subagent route |
| `apiKeyEnv` | `INFERHUB_API_KEY` | Credential reference holding the `sk-airo-…` key |
| `baseURL` | `https://api.inferhub.dev` | Inference base (OpenAI chat-completions) |
| `managementURL` | `https://inferhub.dev/api` | Management base (`/catalog`, `/combos`, …) |
| `catalogTtlSeconds` | `300` | Catalogue cache lifetime (minimum 30) |
| `ignoreUpstreams` | `[]` | Upstream prefixes excluded from both routes |
| `ceilings` / `modelCeilings` | `{}` | Extra ceilings; tightest wins, never loosens `cheapest` |
| `budgets` | `{warnPercent: 0.8, enforce: true}` | Local spending guard |

No per-upstream routes are generated (`upstreamRoutes` is forced `off`):
this plugin is exactly two routes, nothing more.

### Keys without management scope

If your key answers InferHub's management surface (`/catalog`, `/combos`,
`/budgets/aliases`) with 403, the plugin degrades instead of blanking the
picker: alias floors and ladders are derived from the member rows
`GET /v1/models` itself carries, so both routes stay floor-pinned. This is
covered by the `managementForbidden` integration test.

```yaml
# DSH settings.yaml — swap the pair without touching code
inferhub-duo:
  orchestratorAlias: glm-5.3
  orchestratorLabel: InferHub Orchestrator
  subagentAlias: deepseek-v4.1-flash
  subagentLabel: InferHub Subagent
```

A malformed alias degrades to the default (the route keeps serving); a
well-formed but unknown alias leaves that route empty rather than widening
it to other models. Edits apply live — no restart.

## Using the pair

Pick per session in the model picker (`InferHub Orchestrator → GLM 5.3` for
the loop, `InferHub Subagent → DeepSeek V4.1 Flash` for dispatched
subagents), or pin the loop default in the profile:

```
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: inferhub-orch
    model: glm-5.3
```

## Verify

```bash
npm run typecheck    # tsc --noEmit, clean
npm test             # vitest, 16 tests green
```

After installing into a profile, `GET /dsh-inferhub-duo/status` (same-origin,
behind the composition's Host/Origin fence) reports both routes, their
models, the ceilings in force, catalogue staleness, and local spend. The
path is deliberately off `/dsh-inferhub/*` so the two plugins never collide.

## Layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | Plugin entry: two cheapest routes, settings section, status route |
| `src/duo-config.ts` | Duo settings schema, normalization, mapping to runtime settings |
| `src/runtime.ts` | Single seam onto the `dsh-inferhub` runtime (values) + local type mirror |
| `tests/` | Config unit tests + boot integration vs a mock InferHub |
