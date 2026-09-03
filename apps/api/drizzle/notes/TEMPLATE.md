# NNNN_name

> Copy this beside every migration. `pnpm test` fails without it, and fails
> again if the list below does not match what the SQL actually does.

## What it changes

One or two sentences. What a reader needs in order to understand the rollback.

## Locks

One line per risky statement kind the file contains, or `- none`. The kinds are
the ones `tools/migrations/policy.ts` knows about, and the test compares this
list against the file — so a missing line and an invented one both fail.

- `none`

<!-- For a table that has rows in it, say how the lock was made survivable:

- `alter-column-type`: rewrites every row under ACCESS EXCLUSIVE. Run with
  `SET lock_timeout = '3s'; SET statement_timeout = '30s';` at the top of the
  file so a blocked migration gives up instead of queueing every reader behind
  it, and retry rather than waiting.
- `add-check-constraint` / `add-foreign-key`: add it `NOT VALID`, then
  `VALIDATE CONSTRAINT` in a second migration — the validation scan takes only
  a SHARE UPDATE EXCLUSIVE lock and does not block writes.
- `create-index`: `CREATE INDEX CONCURRENTLY`, which cannot run inside a
  transaction and therefore needs a migration file of its own.
- `set-not-null`: add a `CHECK (col IS NOT NULL) NOT VALID`, validate it, then
  `SET NOT NULL` — PostgreSQL 12+ uses the validated constraint and skips the
  scan.
-->

## Rollback

The statements that undo it, or the sentence that says it cannot be undone and
what would be lost. "Not applicable" is not an answer; "this deletes data and
there is no way back" is.
