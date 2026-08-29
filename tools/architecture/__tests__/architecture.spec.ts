import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * A boundary rule nobody has seen fail might not work. These run the real
 * `.dependency-cruiser.cjs` against a tree that breaks it on purpose, so a config
 * change that stops catching violations fails here rather than in a later review.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const CONFIG = join(REPO_ROOT, '.dependency-cruiser.cjs');
const FIXTURES = join(REPO_ROOT, 'tools', 'architecture', 'fixtures');

interface CruiseViolation {
  readonly rule: { readonly name: string };
  readonly from: string;
  readonly to: string;
}

interface CruiseResult {
  readonly summary: { readonly violations: readonly CruiseViolation[] };
}

/**
 * Everything `pnpm lint:deps` cruises, held in step with the script by the final
 * test here: a net covering less ground than the check it stands in for is worse
 * than none, because it reads as reassurance.
 */
const LINTED_TARGETS = ['packages', 'tools', 'scripts', 'eslint.config.mjs', 'vitest.config.mts'];

function cruise(targets: readonly string[], cwd: string): CruiseResult {
  const result = spawnSync(
    'pnpm',
    ['exec', 'depcruise', ...targets, '--config', CONFIG, '--output-type', 'json'],
    { cwd, encoding: 'utf8', shell: process.platform === 'win32' },
  );

  if (result.stdout === '') {
    throw new Error(`dependency-cruiser produced no output.\n${result.stderr}`);
  }
  return JSON.parse(result.stdout) as CruiseResult;
}

describe('the boundary rules fire on a tree that breaks them', () => {
  let violated: Set<string>;
  let violations: readonly CruiseViolation[];

  beforeAll(() => {
    violations = cruise(['packages'], FIXTURES).summary.violations;
    violated = new Set(violations.map((violation) => violation.rule.name));
  });

  it('catches a framework import inside a framework-free package', () => {
    expect(violated).toContain('no-framework-in-packages');

    const offending = violations.find(
      (violation) => violation.rule.name === 'no-framework-in-packages',
    );
    expect(offending?.from).toBe('packages/domain/framework-import.ts');
    expect(offending?.to).toBe('@nestjs/common');
  });

  it('catches a circular import', () => {
    expect(violated).toContain('no-circular');
  });

  it('catches a file nothing imports', () => {
    expect(violated).toContain('no-orphans');

    const offending = violations.find((violation) => violation.rule.name === 'no-orphans');
    expect(offending?.from).toBe('packages/domain/orphan.ts');
  });

  it('catches a spec file that is not inside a __tests__ directory', () => {
    expect(violated).toContain('tests-live-in-tests-folder');

    const offending = violations.find(
      (violation) => violation.rule.name === 'tests-live-in-tests-folder',
    );
    expect(offending?.from).toBe('packages/domain/misplaced.spec.ts');
  });

  it('reports every violation, not just the first', () => {
    expect(violated.size).toBeGreaterThanOrEqual(4);
  });
});

describe('the repository itself', () => {
  it('has no boundary violations anywhere lint:deps looks', () => {
    const { summary } = cruise(LINTED_TARGETS, REPO_ROOT);
    expect(summary.violations).toEqual([]);
  });

  it('cruises exactly what lint:deps cruises', () => {
    // Otherwise adding `apps` to the script leaves this file passing over the old tree.
    const manifest: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const script = (manifest as { scripts: Record<string, string> }).scripts['lint:deps'];

    expect(script).toBe(`depcruise ${LINTED_TARGETS.join(' ')}`);
  });
});
