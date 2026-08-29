# `@fca/config`

Reads the environment once, validates it, and hands back a typed configuration
object. Depends on `zod` and nothing else.

## Why it throws instead of returning a `Result`

The rest of the codebase returns `Result` for failures a caller can act on. A
malformed environment is not one of those: there is no sensible way to continue,
and the only correct response is to stop before the process starts serving. So
`loadConfig` throws `ConfigError`, and it reports **every** problem at once —
finding three mistakes over three restarts is how a deploy loses an afternoon.

## What it refuses

Each rule exists because the failure it prevents otherwise appears far from its
cause:

| Rule                                     | The failure it moves forward                                    |
| ---------------------------------------- | --------------------------------------------------------------- |
| `DATABASE_URL` must be `postgres(ql)://` | A Redis URL pasted here surfaces as a driver error mid-request  |
| `REDIS_URL` must be `redis(s)://`        | Same, in the other direction                                    |
| `JWT_SECRET` at least 32 chars           | Never surfaces at all                                           |
| Numbers parsed from digits only          | `NaN` reaching a port number or a spending limit                |
| `USAGE_LIMIT_USD` capped at 1,000,000    | Keeps the conversion to `MicroUsd` far from the precision limit |

## Secrets

`ConfigError` names which variables are wrong and why, never what they held. A
`DATABASE_URL` contains a password and a boot failure is exactly the moment a
stack trace gets pasted into a chat window. There is a test for this: every
secret is present and valid while a different variable is broken, and the
message is asserted not to contain any of them.

`SECRET_ENV_KEYS` lists the credential-bearing variables so loggers can redact
them by name.

## `.env.example` is part of the contract

`__tests__/env-example.spec.ts` reads the real `.env.example` from the
repository root and checks both directions: no documented variable is unknown to
the schema, and no variable without a default is missing from the file. It also
loads the file for real, so the documented values must actually be valid.

That is the one place this package knows about the repository around it, and it
is deliberate — the file is the only instruction a new machine gets.

## Usage

```typescript
import { loadConfig } from '@fca/config';

const config = loadConfig(process.env);
config.usage.limitUsd; // number — the budget module converts it to MicroUsd once
```

Money stays a plain number here on purpose. Configuration is text an operator
edits; converting it to `MicroUsd` is the budget module's job, and doing it in
one place keeps the float from spreading.
