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
├── conversation/            bounded context: conversations and their messages
├── identity/                bounded context: password hashing, tokens, sessions
├── generation/              bounded context: the policy, the tool, the catalog, the model, the runner
└── shared/
    ├── async/               the one place a timeout is written
    ├── cache/               LayeredCache: memory, Redis, and one call to the source
    ├── config/              the APP_CONFIG token
    ├── cpu/                 worker pool for work that would stall the event loop
    ├── financial/           the pool SQL written by a model runs on, as llm_reader
    ├── health/              live and ready probes
    ├── http/                response envelope, error filter, request context, session guard
    ├── observability/       AppLogger and the bridge NestJS logs through
    ├── persistence/         schema, DatabaseService, UnitOfWork, outbox relay
    ├── queue/               the pump that drains the outbox, and the worker that runs it
    └── redis/               RedisService, Lua scripts, the key registry
```

`budget/` lands as it is built, split into `domain`, `application`,
`infrastructure` and `presentation`; `generation/` has the first two of those so
far — the durable stream and the HTTP surface are the phases after this one.

A layer may only depend inwards and a context may not import another's internals
— both enforced by `.dependency-cruiser.cjs`, with fixtures in
`tools/architecture/` that prove the rules fire. Anything two contexts need to say
the same way, such as `OwnerScope`, lives in `@fca/domain` rather than in
whichever one happened to need it first.

## The rules this package exists to hold

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
`scope`, `task`, `sqlDigest`, `rows`, `err` — so attaching an answer or a question
is a compile error rather
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

`OutboxPump` is what drives it — a task registered with `TaskRegistry`, polling
rather than waiting on `LISTEN/NOTIFY`, because a notification nobody is
listening for at that instant is lost and the whole point of the outbox is that
nothing is. `DomainEventWorker` runs the other end, dispatching a job to
whichever handler declares that type and finishing quietly when none does: the
outbox records every event the domain has, and failing the ones nothing consumes
would fill the failed set with things working as intended. Who consumes what is
composed at the composition root, next to the readiness list and for the same
reason. Both halves run in the API process and still speak through Redis, so
moving the worker into its own process changes where it is started and nothing
about how either behaves.

A job arrives from Redis, which is outside this process, so it goes through zod
exactly as an HTTP body does — a queue outlives a deployment, and yesterday's
job is still in it after a rename.

Every invariant the domain states is also a database constraint — `UNIQUE`,
`CHECK`, a partial unique index — because application code is the layer most
likely to have the bug. `src/shared/persistence/__tests__/constraints.int.spec.ts`
watches each one reject what it claims to.

**SQL from the model is a tree before it is a statement, and only the tree that
was accepted ever runs.** `PgAstSqlPolicy` parses with PostgreSQL's own parser,
walks every key of the resulting tree against an allowlist, and hands back the
**deparsed** form — so a comment hiding a second statement, or anything else the
parser reads differently from a person, is discarded with the original string.
The allowlist is inverted on purpose: a list of forbidden node types is a list of
the ones somebody thought of, and `SELECT * INTO t2 FROM x` settles that on its
own by arriving as a field on the select with no node type of its own to forbid.

The result is a `CanonicalSql`, whose constructor is private and whose factory a
lint rule keeps inside the policy, and `FinancialQueryPool.query` takes nothing
else — so "run this string the model wrote" does not compile. Under that sits the
`llm_reader` role: `SELECT` on one table, read-only, cut off after three seconds.
`financial-query.int.spec.ts` executes the shipped `01-roles.sql` and
`grant-llm-reader.sql` against a real server and then watches PostgreSQL refuse
a write, refuse another table, and cancel a query that will not finish.

A result goes back to the model as columns, rows and a ready-made display string
for every column holding an amount — formatted by the same function the finished
answer is checked against, so a figure the model copies is supported by
definition rather than by luck. Which columns those are is read off the query
rather than off the names it returns: `sum(revenue)` comes back called `sum`, and
a name is not a unit. A `*` is resolved through every relation it ranges over —
the table, a `WITH` name, a subselect, both sides of a join — rather than assumed
to be the table's columns, and where the unit still cannot be established, an
expression dividing one amount by another for instance, there is no display
string at all. A wrong one is worse than none: evidence is matched by value across
every column, so `$2.0K` printed against the fiscal year 2024 would find support
in the year column and pass verification while being wrong.

For the same reason the policy refuses a query whose result would have two
columns of the same name. `SELECT sum(revenue), sum(net_income)` returns two
columns both called `sum`; the display strings are keyed by name, so one cannot
be expressed at all, and a figure copied from the survivor finds support in the
other column. The model is told to name them with `AS`. Resolving `*` is what
makes that check able to see the collision: `SELECT a.*, b.revenue` over a
self-join has a `revenue` on each side, and reading the star as "no columns"
rather than as "these columns" is what once let this year's question be answered
with last year's figure. The tool declines to build a display string for a name
the driver returned twice as well, since that guard does not depend on any of the
reasoning above being right.

**Nothing in this repository says what the dataset covers.** The companies, the
years and the gaps are read from the table at boot and again every ten minutes,
and everything downstream is a projection of that one answer: the prompt the
model is given, the years a figure may be attributed to, and the sentence said
when the data is not there. Reseed with a different dump and all three move
together, because none of them has its own copy.

The catalog carries a fingerprint, which is what makes the prompt cacheable: the
system message is a pure function of the catalog, so an unchanged fingerprint
means a byte-identical prefix. Measured against the configured endpoint, 1,536 of
1,825 prompt tokens came back served from the provider's cache on the second
call.

**The rules in the prompt are there because something was measured.** Each one
cost a wasted draft or a wasted round before it was written: copy the display
strings rather than formatting figures (without it the model wrote SQL to format
them and failed to finish two questions in twelve); query before saying the data
is absent (a refusal with no query behind it is refused by verification exactly
like an unsupported figure); return a percentage as a percentage (`0.5874` in the
result cannot support `58.7%` in the sentence); multiply before dividing two
amounts (they are integers, so the fraction is otherwise lost, which the model
discovers by reading a column of zeroes and asking again); and order with `NULLS
LAST` (or "the five largest" begins with the three that have no figure at all).

**The provider is behind an anti-corruption layer.** No type from the SDK appears
outside `generation/infrastructure`: what leaves the gateway is text, finished
tool calls, what the call cost and why it stopped. Retries are the SDK's, which
knows its own status codes and reads `retry-after`; a second retry wrapped around
that would multiply rather than add. What the SDK has no opinion about is the
fifth consecutive failure, so the circuit breaker is ours.

A smoke call at boot asks whether the endpoint streams and whether it will call a
tool — plenty of OpenAI-compatible endpoints hold a conversation perfectly and
ignore `tools`, and nothing else notices until the first question comes back
ungrounded. What it finds is logged and held, not made a readiness condition, for
the reason readiness gives above.

**One question can take more than one draft, and every draft is read before
anyone else sees it.** The runner puts the pieces in a loop: the model writes, the
tool answers, the claim gate reads every character as it streams, and the
verifier reads the finished draft. A figure with nothing behind it ends the draft
where it stands — the request is aborted rather than paid for to the end — and
the model is told which figure and asked again. Three drafts is the limit; after
that the answer is assembled from the rows themselves and verified like any
other.

What the reader has already seen is always safe to discard, because everything
released has been checked. That is why a repair is a `draft_reset` and not a
correction: there is nothing to correct, only something not to have said.

`GenerationPhase` in `@fca/domain` drives it rather than decorating it, and it
refuses things. There is no edge from `streaming` to `repairing`: a draft is only
rewritten by way of `verifying`, which is the machine insisting that nothing is
rewritten except because something read it. Every path leaves through `settling`
into `closed`, which is what guarantees no generation finishes holding a budget
reservation.

When something outside breaks — a refused key, a closed circuit, a socket that
will not open — the sentence a person reads is chosen from a code, and what the
provider actually said goes to the log in the one file that knows there is a
provider. The two never swap places.

Evidence belongs to one generation. History is replayed as text and never as old
tool results, so a figure from an earlier answer has nothing supporting it here
and the model has to ask again — which, measured against the real model, is
exactly what it does.

**A list is read by keyset, never by offset.** `OFFSET n` reads n rows in order
to throw them away, and the rows move underneath whoever is reading: a
conversation created between two pages shifts every later position by one, so
one row is served twice and its neighbour never. A page asks the database for
one row more than it returns, which makes "there is another page" a row that
exists rather than a guess from `items.length` — a guess that is wrong exactly
when the last page is full. The cursor is opaque and carries a position, not a
permission; the owner still comes from the session, and a tampered one is a
`validation` failure. It is checked by parsing what came _out_ of the decode,
because `Buffer.from(raw, 'base64url')` does not reject input that is not
base64: it drops the characters it cannot read and returns the rest, so a
`catch` around the decode would be a branch that can never run while the
malformed value walks on into the query.

Every instant is stored to the millisecond rather than PostgreSQL's default
microsecond, for the same reason. A JavaScript `Date` holds milliseconds and so
does the ISO string these columns leave as, so a column carrying more precision
than anything that reads it can represent means a cursor built from a value read
back is not the value stored — and the page after it steps over every row that
shared the truncated millisecond. `keyset.int.spec.ts` also reads the query plan
of the statement the repository actually runs, so an index that stops serving
the list fails a test rather than turning up as slowness months later.

A refresh token is a row in `session_tokens` keyed by its own hash, not a column
on `sessions`. That is what makes "no two sessions ever answer to one token" a
primary key: with a current and a previous column, the same hash could be the
live one on one row and the retired one on another, and the query that detects a
stolen token would get two answers with nothing to choose between them.
Superseded rows are kept, because presenting one is the evidence that a copy of
it exists — except in the seconds right after a rotation, where it is more likely
two tabs refreshing together. That request fails either way; only outside the
window does the whole lineage get revoked, and `REFRESH_REUSE_GRACE_SECONDS=0`
removes the exception. Refreshing also slides the session's expiry forward, but
never past `absolute_expires_at`, which a `CHECK` holds rather than the query.

Signing in answers the same sentence whether the address is unknown or the
password is wrong, and pays for a full argon2 verification either way — against
a stand-in hash carrying the same cost parameters when nobody matched, because
an early return is what makes the two distinguishable by a stopwatch. Attempts
are counted in a Redis sorted set before the account is even looked up, per
address and per caller separately, so one account cannot be ground down from
many hosts and one host cannot walk a list of addresses. The trim, the count and
the insert are one Lua script: run as three commands, two callers both read a
count of four and both become the fifth.

Registering is counted too, on a key of its own. It answers the same question
signing in answers — whether an address is taken — and it is the only
unauthenticated path that spends an argon2 hash, so leaving it open would make
the limit on the other door decorative. It is counted **per host only**:
counting it per address would hand anyone a way to lock a known account out of
signing in by registering its email over and over.

**A token never reaches JavaScript.** Both session tokens leave as `httpOnly`
cookies and never appear in a body, so a script that gets onto the page cannot
read one; the refresh cookie is additionally pinned to `/api/v1/auth`, because
every other request that carries it is a request that could leak it. The third
cookie is the opposite on purpose: `fca_csrf` is readable, and a mutation that
arrives carrying a session must echo it in a header. A cross-site page can make
the browser send cookies but cannot read one, so the echo is proof the request
came from our own script. The check applies whenever a session cookie is
present rather than to a list of routes — a list is a thing to forget when the
next endpoint lands.

`ZodBody` binds a handler to the schema in `@fca/contracts` instead of a DTO, so
a renamed field breaks the build rather than a request. It reports which fields
failed and never what they held: the body of `/auth/login` is a password.

**Someone else's row is indistinguishable from one that does not exist.** Every
repository of an owned resource takes an `OwnerScope`, so a query that forgot to
filter by owner is not a call that can be written; the scope comes from the
verified token and never from a body or a query string. Reaching for another
user's session answers 404 rather than 403, and so does an id that is not even a
UUID — a 403 confirms the id names something, and a 400 separates "wrong shape"
from "not yours", which is half of what the 404 is hiding.

A message is written once however many times it is sent. The browser generates
a `clientMessageId` per send and a retry carries the same one, so
`uq_message_client_id` is what makes the second write impossible — not a read
beforehand, which two simultaneous requests would both pass. The read that
matters happens after the constraint has spoken: the row it collided with is
fetched and answered with, marked as not newly created, so a client that
retried gets its message rather than an error it cannot act on.

Allocating the sequence number needs the retry as much as the clever `INSERT`.
Computing `MAX(seq) + 1` inside the statement keeps the read and the write
together but does not serialise them: under read committed two appends see the
same committed maximum and the second loses to `uq_message_seq`. Two things make
that survivable, and both were measured rather than assumed. Each attempt runs
in a scope of its own — a `SAVEPOINT` when there is already a transaction —
because a unique violation aborts the transaction it fires in and PostgreSQL
then refuses every statement until that transaction ends, so a retry issued in
the same scope answers `current transaction is aborted` instead of trying again.
And the retry waits a random moment first, scaled by how many times this writer
has already lost: retrying instantly sends every loser back into the same
instant, which lost seven to ten of a hundred concurrent sends with every stored
sequence still gapless — work missing rather than work wrong, and invisible to a
test that checks only the numbers.

The first message also names the conversation, in the same transaction that
wrote it, so a crash cannot leave a title describing a message that was rolled
back.

A conversation is deleted in two halves. The request marks it `deleting` and
writes `conversation.delete_requested` to the outbox in one transaction, then
answers 202 — from that moment it is absent from every read, because the clause
that hides it is in the repository rather than in each use case, and
`ConversationSummary` carries no state for a caller to forget to check. The rows
go afterwards, in the worker: a conversation may have a generation running
against it, and stopping that crosses Redis and a queue and has to survive being
retried, none of which one HTTP request can offer. Deleting the same
conversation twice is a 404 the second time, and publishes nothing — the update
is conditional on the conversation still being active, so two clicks cannot
queue two deletions.

The worker removes only a conversation that is in `deleting`, and that predicate
is what stands in for the ownership check it has no caller to make: an id
arriving from anywhere cannot destroy a conversation somebody is still using.
Removing one that is already gone answers `false` rather than throwing, because
at-least-once delivery makes a second attempt ordinary rather than exceptional —
and the messages go with the conversation through the database's own cascade,
not a second delete this code has to remember.

Sessions and their tokens are the only tables that grow with every sign-in and
every refresh and are never otherwise deleted from, so `SessionJanitor` sweeps
the ones that stopped being usable longer ago than `SESSION_RETENTION_DAYS`. It
is the first recurring job here and sets the shape for the rest: the loop
registers with `TaskRegistry`, so shutdown waits for a sweep in progress and
cancels one that is only sleeping, and a sweep that throws is logged rather than
ending the loop — a janitor that stops after one bad night is one nobody notices
has stopped.

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
