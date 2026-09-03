# 0004_millisecond_instants

## What it changes

Narrows every `timestamptz` in the schema to `timestamp(3)`, so what PostgreSQL
stores and what an ISO-8601 string on the wire can carry are the same instant.
A microsecond that survives a round trip through the database and not through
JSON is a row that stops being equal to itself.

## Locks

- `alter-column-type`: twenty statements, each rewriting its table under ACCESS
  EXCLUSIVE — the heaviest shape in this directory. Safe only because every
  table was empty. On a populated database this is an expand/contract: add a
  `timestamp(3)` column beside the old one, backfill in batches, switch the
  readers, then drop the original. Run with `SET lock_timeout = '3s';` at the
  top so a blocked migration gives up rather than queueing every reader behind
  it.

## Rollback

`ALTER COLUMN … SET DATA TYPE timestamp with time zone` for each of the twenty,
which restores the type but **not the data**: any sub-millisecond precision was
truncated by this migration and is gone. Since every value is written by this
application in milliseconds, nothing has ever been lost in practice — but the
rollback is a type change, not a repair.
