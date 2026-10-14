#!/usr/bin/env node
/**
 * Dev-only module bridge for harness packages.
 *
 * A plugin installed *under* a DSH profile resolves `@deepseek-ai/dsh-*` through
 * the profile's resolution anchor (`$DSH_HOME/profiles/node_modules/@deepseek-ai`),
 * which symlinks every harness package at the single installed copy inside the
 * `dsh` package. A `file:`-linked checkout lives outside that tree, so tsc, vitest,
 * and the runtime would otherwise not find those specifiers at all.
 *
 * This script links the exact packages this plugin imports into its own
 * `node_modules/@deepseek-ai`, pointing at that same installed copy. The identity
 * of the resolved realpath is load-bearing: a *separately downloaded* copy of
 * `@deepseek-ai/cordis` or `schemastery` would fork the service classes and the
 * schema engine. Never add a harness package to `dependencies`/`devDependencies`.
 */
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(projectRoot, 'package.json'));

/** Packages this plugin imports at build, test, or runtime. */
const PACKAGES = [
  'cordis',
  'schemastery',
  'dsh-brand',
  'dsh-llm',
  'dsh-credentials',
  'dsh-credentials-local',
  'dsh-settings',
  'dsh-settings-file',
  'dsh-home-paths',
  'dsh-atomic-write',
];

/** Locate the directory that physically holds every harness package. */
function harnessScopes() {
  const scopes = [];
  if (typeof process.env.DSH_HARNESS_SCOPE === 'string' && process.env.DSH_HARNESS_SCOPE !== '') {
    scopes.push(process.env.DSH_HARNESS_SCOPE);
  }
  try {
    const dshPackage = require.resolve('@deepseek-ai/dsh/package.json');
    scopes.push(join(dirname(dshPackage), 'node_modules', '@deepseek-ai'));
  } catch {
    // `@deepseek-ai/dsh` may not be in this process's resolution path; the
    // profile anchor below covers every other case.
  }
  const home = process.env.DSH_HOME ?? (process.env.HOME === undefined ? '' : join(process.env.HOME, '.dsh'));
  if (home !== '') scopes.push(join(home, 'profiles', 'node_modules', '@deepseek-ai'));
  return scopes;
}

const scope = harnessScopes().find((candidate) => existsSync(join(candidate, 'dsh-llm')));
if (scope === undefined) {
  console.error('link-dsh: could not locate the installed harness packages.');
  console.error('link-dsh: set DSH_HARNESS_SCOPE to the directory holding @deepseek-ai/dsh-llm.');
  process.exit(1);
}

const target = join(projectRoot, 'node_modules', '@deepseek-ai');
mkdirSync(target, { recursive: true });

let linked = 0;
let skipped = 0;
for (const name of PACKAGES) {
  const source = join(scope, name);
  if (!existsSync(source)) {
    console.warn(`link-dsh: ${name} is not installed in the harness scope — skipped`);
    skipped += 1;
    continue;
  }
  const link = join(target, name);
  if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false }) !== undefined) {
    const current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : '<real directory>';
    if (current === source) {
      skipped += 1;
      continue;
    }
    rmSync(link, { recursive: true, force: true });
  }
  symlinkSync(source, link, 'dir');
  linked += 1;
}

console.log(`link-dsh: harness scope ${scope}`);
console.log(`link-dsh: ${String(linked)} linked, ${String(skipped)} already present`);
