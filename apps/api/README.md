# `@fca/api`

NestJS on Fastify. This is the only package allowed to know about a framework;
everything it decides with lives in `packages/*`.

## Layout

```text
src/
├── main.ts                  process entry point
├── create-app.ts            builds the app without listening, so tests use the real wiring
├── app.module.ts            composition root — every binding by token
├── bootstrap/fastify.ts     adapter options, request-id hook
└── shared/
    ├── health/              live and ready probes
    ├── http/                response envelope, error filter, request context
    └── observability/       AppLogger and the bridge NestJS logs through
```

Bounded contexts (`identity/`, `conversation/`, `generation/`, `budget/`) land as
they are built, each split into `domain`, `application`, `infrastructure` and
`presentation`. A layer may only depend inwards and a context may not import
another's internals — both enforced by `.dependency-cruiser.cjs`, with fixtures
in `tools/architecture/` that prove the rules fire.

## Three rules this package exists to hold

**Nothing about how the server is built reaches a caller.** `DomainErrorFilter`
answers with the status a code implies and wording written for a person. Both
the domain's own message — which names ids and tables — and the framework's are
discarded to the log; neither is written for a user, and a framework message can
quote an internal detail. An unexpected exception becomes a generic 500 with its
stack logged and never sent.

`ApiErrorCode` is deliberately wider than `DomainErrorCode`: the domain names
business failures, and the transport adds the ones only it can have — a request
too large to read, a caller who has not signed in, a bug. A failure raised deep
in Fastify, before any handler runs, still comes out in the same envelope with a
code from that set, so a client switches on one thing.

**A log line cannot carry message content.** `LogContext` lists the only fields
allowed — `requestId`, `userIdHash`, `conversationId`, `messageId`, `durationMs`,
`scope`, `err` — so attaching an answer or a question is a compile error rather
than a rule to remember. `AppLogger` deliberately does not implement NestJS's
`LoggerService`, whose `(message: any, ...params: any[])` signature would reopen
the hole; `NestLoggerBridge` adapts the framework's calls instead.

**Liveness never touches a dependency.** A database outage must not restart the
process. Readiness does check, through indicators the owning modules register,
with a timeout — a dependency that never answers is down, not pending. The
language model is deliberately not a readiness dependency: reading history and
signing in keep working while a provider is unavailable.

## Running it

```bash
pnpm build                       # emits dist/ for every package, in order
pnpm --filter @fca/api start     # reads ../../.env, then node dist/main.js
```

Node does not read a `.env` on its own, so `start` passes
`--env-file-if-exists`. Fill in the repository's `.env` first: `@fca/config`
refuses to start on a bad environment and says which variables are wrong.

Tests never open a socket: they build the real app and inject requests through
Fastify, so the adapter, the filter and the providers under test are the ones
that ship. `src/__tests__/create-app.spec.ts` goes further and boots the graph
with no overrides at all — every other spec replaces providers to isolate what
it is testing, which would otherwise leave the composition root itself, and the
factories that read the environment, exercised by nothing.

Coverage includes this package. `main.ts` is the single exclusion: it starts a
process and listens, which a unit test cannot do without becoming a worse copy
of running the app.
