# 0001_outbox_type_check

## What it changes

Adds `chk_outbox_type` to `outbox_events`, so the event names the relay
dispatches on are a closed set in the database as well as in the type. An
invariant only the code holds is one a bad deploy can write around.

## Locks

- `add-check-constraint`: PostgreSQL takes ACCESS EXCLUSIVE on `outbox_events`
  and scans every row to validate. Safe here because the table was empty when
  this ran — and because the outbox is drained continuously, so it is never
  large. On a table with rows, add it `NOT VALID` and validate separately.

## Rollback

`ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_type;` — instant, and
loses nothing. Rows already written stay valid.
