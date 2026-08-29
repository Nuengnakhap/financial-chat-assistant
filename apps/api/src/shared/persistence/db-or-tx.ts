import type { Database } from './database.service';

/**
 * A repository does not care whether it is inside a transaction — the same
 * methods have to work either way, so callers cannot accidentally run half a
 * unit of work outside one.
 */
export type DbOrTx = Database | Parameters<Parameters<Database['transaction']>[0]>[0];
