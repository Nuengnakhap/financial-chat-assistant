# 0003_session_absolute_lifetime

## What it changes

Adds `sessions.absolute_expires_at` and the constraint that keeps a sliding
expiry inside it, so a session that is used constantly still ends.

## Locks

- `set-not-null`: the column is added nullable first, then made `NOT NULL`,
  which scans the table under ACCESS EXCLUSIVE. Safe here because `sessions`
  was empty. On a populated table: add the column, backfill in batches, add a
  `CHECK (absolute_expires_at IS NOT NULL) NOT VALID`, validate it, and only
  then `SET NOT NULL` — PostgreSQL 12 and later reuse the validated constraint
  and skip the second scan.
- `add-check-constraint`: `chk_sessions_within_absolute`, validated in the same
  statement and under the same lock.

## Rollback

```sql
ALTER TABLE sessions DROP CONSTRAINT chk_sessions_within_absolute;
ALTER TABLE sessions DROP COLUMN absolute_expires_at;
```

Sessions then have no ceiling again. No account data is lost.
