import { describe, expect, it } from 'vitest';

import { CanonicalSql } from '../canonical-sql.vo';

describe('CanonicalSql', () => {
  it('carries the text the policy deparsed', () => {
    expect(CanonicalSql.__fromPolicy('SELECT * FROM financial_data LIMIT 50').text).toBe(
      'SELECT * FROM financial_data LIMIT 50',
    );
  });

  it('cannot be constructed', () => {
    // @ts-expect-error -- the constructor is private, which is the guarantee. If
    // this line ever stops being an error, so does "only validated SQL runs".
    const forged = new CanonicalSql('DROP TABLE financial_data');

    expect(forged).toBeDefined();
  });

  it('is not satisfied by an object of the same shape', () => {
    // The private member is what makes the type nominal. Without it this
    // assignment would compile, and any string could be passed to the executor
    // by writing an object literal at the call site.
    // @ts-expect-error -- a bare `{ text }` is not a CanonicalSql.
    const forged: CanonicalSql = { text: 'DROP TABLE financial_data' };

    expect(forged).toBeDefined();
  });
});
