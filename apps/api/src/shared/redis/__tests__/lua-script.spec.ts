import { describe, expect, it } from 'vitest';

import { luaScript } from '../lua-script';

describe('luaScript', () => {
  it('derives the digest Redis will store the script under', () => {
    // The value SHA-1 gives for "return 1"; if this changes, EVALSHA misses
    // forever and every call silently falls back to sending the source.
    expect(luaScript('one', 'return 1').sha).toBe('e0e1f9fabfc9d4800c877a703b823ac0578ff8db');
  });

  it('gives a different digest to a script that differs by whitespace', () => {
    expect(luaScript('a', 'return 1').sha).not.toBe(luaScript('a', 'return 1 ').sha);
  });
});
