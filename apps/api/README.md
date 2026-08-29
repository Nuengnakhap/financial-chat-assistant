# `@fca/api`

NestJS on Fastify. This is the only package allowed to know about a framework;
everything it decides with lives in `packages/*`.

## Layout

```text
worker-threads/              entry points loaded by filename on a thread, never imported
src/
├── main.ts                  process entry point — listens, then owns the shutdown sequence
├── create-app.ts            builds the app without listening, so tests use the real wiring
├── app.module.ts            composition root — every binding by token
├── bootstrap/
│   ├── fastify.ts           adapter options, request-id hook
│   ├── task-registry.ts     every background task, so shutdown can wait for it
│   └── shutdown.ts          the order things stop in
├── conversation/            first bounded context: ports and their Drizzle adapters
└── shared/
    ├── async/               the one place a timeout is written
    ├── config/              the APP_CONFIG token
    ├── cpu/                 worker pool for work that would stall the event loop
    ├── health/              live and ready probes
    ├── http/                response envelope, error filter, request context
    ├── observability/       AppLogger and the bridge NestJS logs through
    ├── persistence/         schema, DatabaseService, UnitOfWork, outbox relay
    └── redis/               RedisService, Lua scripts, the key registry
```

Bounded contexts (`identity/`, `conversation/`, `generation/`, `budget/`) land as
they are built, each split into `domain`, `application`, `infrastructure` and
`presentation`. A layer may only depend inwards and a context may not import
another's internals — both enforced by `.dependency-cruiser.cjs`, with fixtures
in `tools/architecture/` that prove the rules fire.

## Five rules this package exists to hold

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
`scope`, `task`, `err` — so attaching an answer or a question is a compile error rather
than a rule to remember. `AppLogger` deliberately does not implement NestJS's
`LoggerService`, whose `(message: any, ...params: any[])` signature would reopen
the hole; `NestLoggerBridge` adapts the framework's calls instead.

**Liveness never touches a dependency.** A database outage must not restart the
process. Readiness does check — PostgreSQL and Redis, with a timeout, because a
dependency that never answers is down rather than pending. The language model is
deliberately not one of them: reading history and signing in keep working while a
provider is unavailable. The list lives at the composition root rather than in
each module, because NestJS keeps one provider per token and two modules
contributing their own list would leave one of them silently unused.

**A change and the news of it are one transaction.** Anything that alters state
and has to reach somewhere else goes through `UnitOfWork`: repositories and an
outbox insert commit together, or neither does. Writing the row and then
enqueueing has a window where a crash leaves a message nobody will ever generate,
or a job for a message that was rolled back. The relay publishes before it marks,
so delivery is at-least-once and consumers deduplicate on the event id.

Every invariant the domain states is also a database constraint — `UNIQUE`,
`CHECK`, a partial unique index — because application code is the layer most
likely to have the bug. `src/shared/persistence/__tests__/constraints.int.spec.ts`
watches each one reject what it claims to.

**Stopping is a sequence, not an event.** On `SIGTERM` or `SIGINT`, readiness is
refused first and the process keeps serving for a grace period, so traffic has
somewhere else to go. Only then do connections close, background work drains, and
the pools and clients get released — in that order, because a pool closed under a
task that is still writing loses the write. The order is driven explicitly from
`main.ts` rather than through lifecycle hooks: `app.close()` runs
`onModuleDestroy` _before_ it closes the HTTP server, which is the wrong way
round, so `enableShutdownHooks()` is deliberately not used.

Every step of it is bounded, and the total is chosen to fit inside a 30-second
grace period. `server.close()` waits for requests already in flight, with no
limit of its own — one connection that never finishes would hold the sequence
before the steps that release anything, and the process would be killed partway
through rather than stopping. So connections that outstay the grace are cut,
exactly as a task that ignores its `AbortSignal` is.

Background work registers with `TaskRegistry` — a generation persisting its
result is not holding any request open, and a bare `void fn()` would be lost on
exit. Once draining starts the registry refuses new tasks, which is what stops a
request already inside the server from beginning work that shutdown would then
have to abandon. A task that ignores its `AbortSignal` is given a bounded grace
and then left behind; a shutdown one task can block forever is not a shutdown.

CPU-bound work goes to a worker pool rather than the event loop. Node runs
JavaScript on one thread, so a few milliseconds of tokenizing stalls every
request already in flight. The pool's entry point is loaded by filename, not
imported, which is why it lives in `worker-threads/` as plain CommonJS with
nothing to build.

## Running it

```bash
pnpm build                       # emits dist/ for every package, in order
pnpm --filter @fca/api start     # reads ../../.env, then node dist/main.js
```

Node does not read a `.env` on its own, so `start` passes
`--env-file-if-exists`. Fill in the repository's `.env` first: `@fca/config`
refuses to start on a bad environment and says which variables are wrong.

## Tests

`pnpm test` never needs Docker. Stores are different: a fake cannot reject a
`CHECK` constraint and never forgets a cached Lua script, so those tests run
against a real PostgreSQL 18 and Redis 8 started by testcontainers, in files
named `*.int.spec.ts` and run by `pnpm test:integration`. They apply the real
migration rather than pushing the schema, so what they prove is the SQL that will
actually run.

`pnpm test:coverage` runs both, and therefore needs Docker.

Unit tests never open a socket: they build the real app and inject requests through
Fastify, so the adapter, the filter and the providers under test are the ones
that ship. `src/__tests__/create-app.spec.ts` goes further and boots the graph
with no overrides at all — every other spec replaces providers to isolate what
it is testing, which would otherwise leave the composition root itself, and the
factories that read the environment, exercised by nothing.

Coverage includes this package. `main.ts` is the single exclusion: it starts a
process and listens, which a unit test cannot do without becoming a worse copy
of running the app.
