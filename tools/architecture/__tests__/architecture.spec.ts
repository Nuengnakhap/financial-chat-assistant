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
const LINTED_TARGETS = [
  'packages',
  'apps',
  'tools',
  'scripts',
  'eslint.config.mjs',
  'vitest.config.mts',
];

/**
 * The whole graph as JSON, which is already over a megabyte and grows with every
 * file added to the repository. `spawnSync` buffers a megabyte by default and
 * then kills the child, so the output arrives cut off in the middle of a string
 * and `JSON.parse` fails somewhere around line thirty thousand — a boundary
 * check that reads as a broken tree rather than as a limit nobody set.
 */
const OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

function cruise(targets: readonly string[], cwd: string): CruiseResult {
  const result = spawnSync(
    'pnpm',
    ['exec', 'depcruise', ...targets, '--config', CONFIG, '--output-type', 'json'],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: OUTPUT_LIMIT_BYTES,
      shell: process.platform === 'win32',
    },
  );

  // Said out loud rather than left to `JSON.parse`: a truncated buffer and a
  // crashed cruiser both arrive as unreadable output, and they are not the
  // same problem.
  if (result.error !== undefined) {
    throw new Error(`dependency-cruiser could not be read: ${result.error.message}`);
  }
  if (result.stdout === '') {
    throw new Error(`dependency-cruiser produced no output.\n${result.stderr}`);
  }

  return JSON.parse(result.stdout) as CruiseResult;
}

describe('the boundary rules fire on a tree that breaks them', () => {
  let violated: Set<string>;
  let violations: readonly CruiseViolation[];

  beforeAll(() => {
    violations = cruise(['packages', 'apps'], FIXTURES).summary.violations;
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

  it('catches a business rule depending on the adapter that stores it', () => {
    expect(violated).toContain('layer-domain-inward');

    const offending = violations.find((v) => v.rule.name === 'layer-domain-inward');
    expect(offending?.from).toBe('apps/api/src/conversation/domain/entity.ts');
    expect(offending?.to).toBe('apps/api/src/conversation/infrastructure/repo.ts');
  });

  it('catches one bounded context reaching into another', () => {
    expect(violated).toContain('no-cross-context');

    const offending = violations.find((v) => v.rule.name === 'no-cross-context');
    expect(offending?.from).toBe('apps/api/src/identity/application/login.ts');
    expect(offending?.to).toBe('apps/api/src/generation/application/start.ts');
  });

  it("catches one domain reaching past another domain's index", () => {
    expect(violated).toContain('web-domain-public-api');

    const offending = violations.find((v) => v.rule.name === 'web-domain-public-api');
    expect(offending?.from).toBe('apps/web/src/domains/billing/Invoice.tsx');
    // A .tsx that resolves is the point: without the extension in the resolver
    // this dependency is invisible and the rule silently passes.
    expect(offending?.to).toBe('apps/web/src/domains/auth/hooks/useSession.ts');
  });

  it('catches a screen reaching past a domain index as well', () => {
    expect(violated).toContain('web-domain-public-api-from-outside');
  });

  it('catches a shared component that fetches', () => {
    expect(violated).toContain('web-dumb-components');
    expect(violated).toContain('web-requests-live-in-the-api-layer');

    const offending = violations.find((v) => v.rule.name === 'web-dumb-components');
    expect(offending?.from).toBe('apps/web/src/components/UsageMeter.tsx');
  });

  it('catches shared code reaching into a screen', () => {
    expect(violated).toContain('web-composition-flows-one-way');
  });

  it('reports every violation, not just the first', () => {
    expect(violated.size).toBeGreaterThanOrEqual(10);
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
