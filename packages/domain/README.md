# `@fca/domain`

Business rules with no framework attached. Nothing in this package imports
NestJS, Drizzle, `pg`, `ioredis`, React or an HTTP library, which is enforced by
the `no-framework-in-packages` rule in `.dependency-cruiser.cjs` rather than by
agreement. That constraint is what lets these rules be tested in milliseconds
without a container, a database or a browser.

## What lives here

| Module                                   | Responsibility                                                   |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `result.ts`                              | `Result<T, E>` — expected failures appear in the signature       |
| `errors.ts`                              | The closed set of domain error codes                             |
| `assert.ts`                              | `assertNever` — makes an unhandled union variant a compile error |
| `identifiers.ts`                         | Branded ids, parsed once at the boundary                         |
| `money/micro-usd.vo.ts`                  | Integer micro-USD money                                          |
| `conversation/message-status.machine.ts` | The lifecycle of a message                                       |
| `generation/generation-phase.machine.ts` | The lifecycle of one attempt to answer                           |

Import from the package root (`@fca/domain`). Deep imports are not part of the
public surface and the file layout is free to change underneath them.

Tests live in a `__tests__` directory beside the code they cover, so a listing
of `src/` shows the modules rather than twice as many files. The
`tests-live-in-tests-folder` rule in `.dependency-cruiser.cjs` enforces it.

## The rules this package exists to enforce

**Expected failure is a value, not an exception.** A budget that is exhausted, a
conversation that does not exist, a status that cannot move — the caller must
decide what to do, so it appears in the return type. `throw` is reserved for
states that should be unreachable; if one happens, it is a bug and the stack
trace is the point.

**An id is not a string.** Every identifier is a UUID, so the compiler cannot
tell a `ConversationId` from a `MessageId` and `delete(messageId)` typechecks
against a function that wanted a conversation. Branding closes that: the tag
exists only in the type system, costs nothing at runtime, and the only way to
mint one is `parse` (untrusted input) or `trusted` (rows from our own database).

**Money is a `bigint` count of micro-USD.** Model prices are quoted per million
tokens at values like $0.20, and `0.1 + 0.2 !== 0.3` in IEEE-754. A budget that
drifts by a rounding error either lets a user overspend or refuses a request
they have paid for, and neither shows up until someone reconciles a ledger.
Division takes an explicit rounding direction because charging must round up.

**A lifecycle is a table, and its shape is tested.** Both state machines are
plain transition tables, and their tests walk the graph rather than checking a
handful of paths:

- a message has exactly one open state and three terminal ones, and no terminal
  state has an outgoing edge — so a Stop arriving after an answer was persisted
  is rejected instead of overwriting it;
- `settling` is the only phase with an edge into `closed`, so a generation
  cannot finish without settling its budget reservation, and every open phase
  can still reach `settling`, so no failure path leaves budget on hold.

Those two tests are the reason the machines are worth having: they check a
property of the whole graph, so a future edge that breaks the invariant fails
even though it was never written down as a case.

## Working on it

```bash
pnpm --filter @fca/domain typecheck   # includes the spec files
pnpm test --project domain            # vitest
pnpm build                            # emits dist/ through the solution build
```

Coverage is held at 95% for this package. It is pure logic with no I/O, so an
uncovered branch means a rule nobody has tested, not a hard-to-reach edge case.
