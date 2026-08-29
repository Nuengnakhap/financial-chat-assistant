import { createHash } from 'node:crypto';

export interface LuaScript {
  readonly name: string;
  readonly source: string;
  /** Redis caches a script under the SHA-1 of its source, so this is not a free choice. */
  readonly sha: string;
}

/**
 * Scripts are declared once and reused, because atomicity is the reason they
 * exist: a reserve that reads and writes in two round trips is not a reserve.
 */
export function luaScript(name: string, source: string): LuaScript {
  return { name, source, sha: createHash('sha1').update(source).digest('hex') };
}
