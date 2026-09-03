# 0002_sessions

## What it changes

Creates `sessions` and `session_tokens`, the refresh-token family and its
rotation chain, with the partial unique indexes that allow one live token per
session and one active session per family.

## Locks

Both tables are created in this migration, so the indexes and foreign keys that
follow are on tables nothing else can see yet.

- `none`

## Rollback

`DROP TABLE session_tokens, sessions CASCADE;` — every signed-in person is
signed out and every refresh token is void. Nothing else is lost: sessions are
derived state, and the accounts they belong to are untouched.
