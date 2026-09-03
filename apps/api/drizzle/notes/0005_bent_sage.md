# 0005_bent_sage

## What it changes

The budget ledger. Creates `usage_events` — the durable record of what each
answer cost, which is what a lost Redis counter is rebuilt from — and gives
`messages` the reservation it holds while it is being written, with a
constraint that keeps the id and the window together or absent together.

## Locks

- `add-check-constraint`: `chk_reservation_is_whole` on `messages`, validated
  under ACCESS EXCLUSIVE. The two columns it constrains were added in the same
  statement block and are null everywhere, so the scan finds nothing to reject —
  but it is still a scan, and on a large `messages` table it should be added
  `NOT VALID` and validated afterwards.

The columns added to `messages` carry a `DEFAULT`, so PostgreSQL 11 and later
record the default in the catalogue instead of rewriting the table.

## Rollback

```sql
ALTER TABLE messages DROP CONSTRAINT chk_reservation_is_whole;
ALTER TABLE messages DROP COLUMN reservation_window, DROP COLUMN reservation_id;
ALTER TABLE messages DROP COLUMN cached_input_tokens;
DROP TABLE usage_events;
```

This deletes the ledger. A Redis counter lost after that has nothing to be
rebuilt from, and every window resets to zero spent.
