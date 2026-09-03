# AGENTS.md

Instructions for AI assistants working in this repository. Humans should read
`README.md` instead — this file is the condensed operating manual.

## Project

Chat application where a signed-in user asks questions about the revenue and
income of U.S. public companies. **Every figure in an answer must be grounded in
SQL query results and is verified automatically before it reaches the user.**

Data coverage is deliberately narrow: 49 companies, fiscal years 2022–2025,
192 rows in one table, `financial_data`. Anything outside that must be answered
with a plain "this dataset does not include it" — never an estimate. Never
hardcode the coverage: it is derived from the database at runtime.

Scope: runs locally (Docker Compose + `pnpm dev`). Deployment concerns
(orchestration, replicas, autoscaling) are intentionally out of scope.

## Non-negotiable rules

1. **No unverifiable figures.** Text streams through a claim gate that holds any
   in-progress numeric literal until it is matched against the tool results.
   A figure without evidence is never emitted — the draft is discarded and
   regenerated instead. Never weaken or bypass this path.
2. **`assistant` message with `status = 'complete'` must carry a verification
   report.** Enforced by type and by a DB `CHECK` constraint. If you change the
   message schema, keep both.
3. **SQL from the LLM is validated as an AST** (`pgsql-parser`), then only the
   deparsed canonical form is executed, through a read-only role that can
   `SELECT` exactly one table. Never execute a string that skipped the policy.
4. **Money is integer micro-USD** (`MicroUsd`, `bigint`). No floats anywhere in
   the budget path.
5. **State changes that trigger work elsewhere go through the transactional
   outbox** — never "write to DB, then enqueue".
6. **Never log message content or model answers** at normal levels.
7. **A question is stripped of invisible characters at the door and never
   afterwards** — `asModelSafeText` in `StartGenerationUseCase`, so what is
   stored, shown, titled and answered is one string. Nothing visible is
   changed: an instruction aimed at the model is left exactly as typed, because
   what makes it harmless is the claim gate and not a filter.

## Architecture in one screen

- Hexagonal: `presentation → application → domain`, `infrastructure → application`.
  Enforced by dependency-cruiser inside `pnpm check`, which CI runs on every
  push — not by convention.
- `apps/web` is domain-driven: a capability lives in `domains/<name>` and is
  entered only through its `index.ts`, one domain never imports another's
  internals, and `components/` is presentational — anything that fetches or
  reads session state belongs to a domain. Same enforcement, same fixtures.
- `packages/domain`, `packages/contracts`, `packages/grounding`, `packages/config`
  are framework-free: no NestJS, Drizzle, pg, ioredis, React imports there.
- Every HTTP body and SSE event is defined once in `packages/contracts` and
  imported by both sides. Money crosses the wire as a micro-USD string, never a
  JSON number. An unknown SSE event is skipped, never fatal. `/healthz/*` is the
  one family outside that rule and always has been: it has no client in
  `apps/web`, so there is no second side to share a definition with, and a probe
  that answered a shape somebody could depend on would be an API rather than a
  probe.
- A response never carries a developer message, an exception name or a stack.
  `DomainErrorFilter` maps a code to a status and to wording written for a person.
- `LogContext` is the closed set of fields a log line may carry. Adding message
  content is a compile error, not a review comment.
- Generation is detached from the HTTP connection: a command creates the message
  and an outbox event; a runner produces events into a Redis Stream; clients
  attach/resume over SSE with `Last-Event-ID`. Disconnect ≠ stop; stopping is an
  explicit `POST /messages/:id/stop`.
- Budget is two-phase: `reserve` before generating, `settle` after, both atomic
  Lua on Redis. Postgres holds the ledger.

## Stack (pinned — verify against the registry before changing)

Node 22.9+ · **TypeScript 6.0** · NestJS 11 on Fastify · Vite 8 + React 19 ·
Drizzle ORM 0.45 + drizzle-kit · PostgreSQL 18 · Redis 8 · zod 4 ·
openai SDK (OpenAI-compatible via `OPENAI_BASE_URL`) · pgsql-parser 18 · BullMQ ·
vitest 4 · fast-check 4 ·
ESLint 10 + typescript-eslint 8 · dependency-cruiser 18 · knip 6 ·
Playwright · testcontainers.

**TypeScript stays on 6.0 deliberately.** TypeScript 7 is the native compiler:
its package exports only `unstable/*`, not the classic `typescript` API that
typescript-eslint's type-aware rules are built on, and typescript-eslint declares
`typescript: >=4.8.4 <6.1.0` accordingly. Moving to 7 would silently remove
`no-floating-promises`, `switch-exhaustiveness-check` and every other rule that
needs a type checker. Revisit when typescript-eslint supports 7.

`pnpm-workspace.yaml` sets `minimumReleaseAge` to three days. If a version is
rejected as too new, widen the range in `package.json` rather than adding an
exclusion.

Do not upgrade a major version as a side effect of another task.

## Code rules

- `strict` TypeScript, `noUncheckedIndexedAccess`. No `any`, no `!`, no `as`
  outside repository mappers and branded-id constructors.
- Branded id types (`UserId`, `ConversationId`, `MessageId`, …) — never pass raw
  strings across a port boundary.
- Every `switch` over a union ends in `assertNever(...)`.
- Expected failures return `Result<T, DomainError>`; exceptions are for bugs.
- Functions ≤40 lines, complexity ≤10, files ≤400 lines.
- zod parses at boundaries only (HTTP body, env, tool args, data read from Redis).
- No floating promises. Background work registers with `TaskRegistry`.
- CPU-bound work never runs on the event loop. The tokenizer goes to `CpuPool`;
  password hashing uses argon2's own async API, which has its own threads.
- `TODO` must carry an issue reference: `// TODO(#123): ...`
- Extending the system — a tool, a provider, a metric, an SSE event, a context,
  a chart type — follows `CONTRIBUTING.md`. Each of those is a fixed, short list
  of files; needing to edit `AgentRunner` to add a tool means the port is wrong,
  not that the runner needs a special case.
- A change to `packages/contracts` is classified by the snapshot gate. Anything
  it has not been taught is breaking, and recording a breaking change needs
  `CONTRACTS_ALLOW_BREAKING=1` said out loud.
- Every migration carries `apps/api/drizzle/notes/<tag>.md` naming the locks it
  takes and how to undo it. `pnpm check` compares the note against the SQL.
- Tests go in a `__tests__` directory next to the code they cover, named
  `<module>.spec.ts` (`.spec.tsx` for a component). Never beside the source file.
  A test that needs a real database is `<module>.int.spec.ts` and runs only under
  `pnpm test:integration`.
- Every domain invariant is also a database constraint, and an integration test
  makes each one fail. A constraint nobody has watched reject something may be
  misspelled.

## Commands

```bash
pnpm check            # build + format + typecheck + lint + db:check + test — before saying done
pnpm infra:up         # Postgres + Redis via Docker Compose
pnpm db:generate      # write a migration from the schema
pnpm db:check         # drizzle-kit check: two branches that both generated one
pnpm db:migrate       # apply migrations as the schema owner (MIGRATION_DATABASE_URL)
pnpm db:seed          # load financial_data.sql + grants + indexes
pnpm dev              # api :3000 + web :5173
pnpm typecheck        # tsc --noEmit per package, spec files included
pnpm test             # vitest, unit only — no Docker needed
pnpm test:integration # persistence against a real PostgreSQL (needs Docker)
pnpm eval             # deterministic grounding suite, inside `pnpm test`
pnpm lint             # eslint + dependency-cruiser + knip
pnpm contracts:snapshot  # re-record the published contract surface after a safe change
pnpm audit            # advisories at high or above; run before delivering

# These three need the stack up (`pnpm infra:up && pnpm dev`) and are not in `pnpm check`
pnpm test:e2e         # Playwright in a real browser: S1, S2, S3, S5, S6 + isolation
pnpm eval:live        # the golden questions through the real model — spends money
pnpm drill <redis|postgres>  # stop a dependency under a running API and watch it recover
```

Everything in this list runs today. The last three are separate from the gate
on purpose: one drives a browser, one spends real money, and one stops a
database — none of which belongs in a command somebody runs before every commit.

`.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile`, `pnpm check`
and `pnpm audit`, then `pnpm test:integration` on a second runner. Those three
stay out of it for the same reason they stay out of `pnpm check`, and because a
pull request from a fork has no API key to spend. **A command this file or any
README tells somebody to run must exist in a `package.json`** — a test in
`tools/docs/` holds that, after two of them went missing for a day.

## Definition of done for a change

Behaviour has a test that would fail if the code were wrong; new invariants are
enforced by a type or a DB constraint rather than an `if`; the error path is
tested; logs/metrics/spans are added in the same change; the affected README is
updated.

## Notes

- Everything a reader of this repository needs must live in `README.md`, module
  READMEs, or here. Never point a committed file at anything outside the
  repository.
- Committed documentation describes **what the system does and how to work on
  it** — not the deliberation behind it. Do not add decision records, design
  rationale, or process notes to the repository.
