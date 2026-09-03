# 0006_tranquil_beast

## What it changes

Narrows `chk_outbox_type` from eight event names to three. The five removed —
`conversation.created`, `message.appended`, `generation.closed`,
`usage.recorded`, `grounding.fallback_used` — had no publisher in two
milestones, and each duplicated a row that already exists and outlives it: the
conversation, the message, the message's status, the `usage_events` ledger, and
the message's own outcome.

What survives is what nothing else records. A conversation is hard-deleted, so
after the purge `conversation.delete_requested` is the only trace that it
existed; `session.token_reuse_detected` is the only record of _why_ a session
family was revoked; and `generation.requested` is a job rather than a record.

## Locks

- `add-check-constraint`: dropping and re-adding the constraint takes ACCESS
  EXCLUSIVE on `outbox_events` and scans it to validate the narrower list. The
  scan is safe here for a reason that is checkable rather than assumed — no row
  can hold one of the five, because nothing ever wrote one. On a table where
  that were not true the narrowing would fail outright, which is the right
  failure: it would mean the vocabulary was still in use.

The `DROP CONSTRAINT` in the same file is not counted: it takes the same lock
this statement already takes, and takes it for the shorter of the two.

## Rollback

```sql
ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_type;
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_type
  CHECK (type IN ('conversation.created', 'conversation.delete_requested',
                  'message.appended', 'generation.requested', 'generation.closed',
                  'usage.recorded', 'grounding.fallback_used',
                  'session.token_reuse_detected'));
```

Widening loses nothing and needs no scan of its own beyond the validation. The
code would also have to put the five names back in `DOMAIN_EVENT_TYPES`, or the
constraint would allow what the type does not.
