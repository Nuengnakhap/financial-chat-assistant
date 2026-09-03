# 0000_initial_schema

## What it changes

Creates the four tables the application starts from — `users`,
`conversations`, `messages`, `outbox_events` — with their foreign keys and
indexes, including the partial unique index that allows one generating message
per conversation.

## Locks

Every statement here is on a table this migration created a moment earlier, so
there is nothing else that could be reading or writing one.

- `none`

## Rollback

`DROP TABLE outbox_events, messages, conversations, users CASCADE;` — which is
every account, conversation and answer in the database. There is no smaller way
back from the first migration, and on anything but a local database this is a
restore from a backup rather than a rollback.
