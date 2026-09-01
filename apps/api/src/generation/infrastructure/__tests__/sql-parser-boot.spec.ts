import { describe, expect, it } from 'vitest';

import { PgAstSqlPolicy } from '../pg-ast-sql-policy';

/**
 * A file of its own, because what it tests is what happens before anything else
 * has happened: the parser is WebAssembly, its synchronous entry points throw
 * until the module is loaded, and every other spec loads it in `beforeAll`.
 *
 * Worth a test rather than a comment. It was a real hour: the first probe read
 * `parseSync` as working without `loadModule`, because an earlier line in the
 * same script had awaited the asynchronous one.
 */
describe('validating before the parser is loaded', () => {
  it('says so, rather than failing somewhere inside the parser', async () => {
    const policy = new PgAstSqlPolicy();

    expect(() => policy.validate('SELECT company FROM financial_data')).toThrow(
      /onModuleInit must run first/u,
    );

    await policy.onModuleInit();
    expect(policy.validate('SELECT company FROM financial_data').ok).toBe(true);
  });
});
