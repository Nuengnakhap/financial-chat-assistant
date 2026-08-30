import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';

import plugin from '../no-off-token-styles.mjs';

/**
 * A guard rule nobody has seen fail might not work — the same reason
 * `architecture/__tests__/architecture.spec.ts` keeps a tree that breaks the
 * dependency rules on purpose. This rule is the only thing standing between the
 * closed token set and `p-[13px]`, and the repository compiles clean, so nothing
 * else would notice if its visitors stopped matching.
 */

const rule = plugin.rules['no-off-token-styles'];

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true }, ecmaVersion: 2023, sourceType: 'module' },
  },
});

describe('no-off-token-styles', () => {
  it('accepts token classes and rejects every way around them', () => {
    // RuleTester throws on the first disagreement, so the assertion is the call.
    tester.run('no-off-token-styles', rule, {
      valid: [
        { code: `const A = () => <div className="p-4 gap-2 bg-surface" />;` },
        { code: `const A = () => <div className={cx('rounded-md', 'text-body-sm')} />;` },
        { code: `const A = ({ on }) => <div className={cx(on ? 'bg-ink' : 'bg-raised')} />;` },
        { code: `const A = ({ on }) => <div className={on && 'bg-ink'} />;` },
        // Not a class list: an arbitrary-looking string elsewhere is none of its business.
        { code: `const sql = 'SELECT a[1] FROM t';` },
        { code: `styled('div', { padding: '13px' });` },
      ],
      invalid: [
        {
          code: `const A = () => <div className="p-[13px]" />;`,
          errors: [{ messageId: 'arbitrary' }],
        },
        {
          code: `const A = () => <div className={cx('gap-2', 'w-[42%]')} />;`,
          errors: [{ messageId: 'arbitrary' }],
        },
        {
          // The idiom that escaped the first version of this rule.
          code: `const A = ({ on }) => <div className={on && 'p-[13px]'} />;`,
          errors: [{ messageId: 'arbitrary' }],
        },
        {
          code: `const A = ({ on }) => <div className={on ? 'p-[13px]' : 'p-4'} />;`,
          errors: [{ messageId: 'arbitrary' }],
        },
        {
          code: 'const A = ({ n }) => <div className={`p-[${n}px] gap-2`} />;',
          errors: [{ messageId: 'arbitrary' }],
        },
        {
          code: `const A = () => <div style={{ width: '42%' }} />;`,
          errors: [{ messageId: 'inlineStyle' }],
        },
        {
          // Reported once, not once per visitor: `cx` inside `className` used to
          // be walked twice.
          code: `const A = () => <div className={cx('w-[42%]')} />;`,
          errors: 1,
        },
      ],
    });
  });
});
