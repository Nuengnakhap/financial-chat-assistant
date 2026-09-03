# Contributing

`README.md` is how to run this. `AGENTS.md` is the rulebook. This is the third
thing: how to **extend** it — the six changes most likely to be asked for, with
the files each one touches and the ones it must not.

Every one of these was walked through against the code rather than imagined.
Where a playbook is short, that is the architecture paying off; where it says
"refactor first", that is the architecture failing and saying so.

## Before anything

```bash
pnpm check   # build, format, types, lint, boundaries, dead code, migrations, tests
```

It is the gate. It needs no containers. `pnpm test:integration` needs Docker
and is separate on purpose.

## A change is done when

- Behaviour has a test that would fail if the code were wrong. Write it first
  and watch it fail; a test written afterwards has never been red.
- A new invariant is held by a type or a database constraint, not by an `if`.
- The error path is tested too.
- The affected README is updated in the same change.

---

## Adding a tool the model can call

**Touches four files. Never touches `AgentRunner`.**

| Step | File                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1    | `generation/infrastructure/<name>.tool.ts` — `implements AgentTool`                                                          |
| 2    | `generation/application/prompt.factory.ts` — its `ToolDefinition`, beside the rule that tells the model when to reach for it |
| 3    | `generation/generation.module.ts` — add it to the `AGENT_TOOLS` array                                                        |
| 4    | `evals/golden/` — a case that should reach it                                                                                |

`describe_coverage` is the worked example: `describe-coverage.tool.ts`, twelve
lines of logic and a definition.

Two things a new tool owns, and the runner never learns:

- **Its arguments**, as the JSON string the model wrote — valid or not. The
  tool parses them.
- **Its failures.** `execute` never throws. A refusal is an outcome the model
  reads and acts on; an exception ends the generation instead.

**What it must return is a `QueryOutcome`** — columns, rows, and the statement
they came from. That is not a formality. A figure in an answer is checked
against tool results, so a tool whose output is not rows is a tool whose output
cannot be evidence for anything, and an answer resting on it is refused.

**If it invents column names, register them.** `coverageOf` in
`semantic-catalog.ts` is where `describe_coverage`'s columns are declared
`plain`. A column the verifier has never heard of is left alone rather than
refused — so an unregistered count of `190` becomes evidence for "$190".

**Never touched:** `AgentRunner` (it sees only a `Draft`), the SSE contract, the
UI. `ToolCall.tsx` draws from `sql` and `preview` and does not know any tool's
name.

## Adding an LLM provider with a different wire format

**Touches four files. Nothing above `LlmGateway` changes.**

| Step | File                                                                               |
| ---- | ---------------------------------------------------------------------------------- |
| 1    | `generation/infrastructure/<name>-llm.gateway.ts` — translate to `CompletionChunk` |
| 2    | `generation/generation.module.ts` — bind it to `LLM_GATEWAY`                       |
| 3    | `budget/application/pricing.ts`, or `PRICING_PATH` with no code at all             |
| 4    | `packages/config/src/env.schema.ts` — anything new it needs                        |

Then run the contract suite against it:

```ts
llmGatewayContract('your provider', harness);
```

It is in `generation/application/ports/__tests__/llm-gateway.contract.ts`, and
it already runs against two adapters that disagree about everything: OpenAI
sends tool arguments in fragments and usage last, `TerseLlmGateway` sends
arguments whole and usage first. **A new gateway passes the suite unedited, or
it has changed the contract rather than implemented it.**

The two things that fail silently, and that the suite exists for:

- The `usage` chunk must carry the model the provider **answered with**, not the
  one it was asked for. A router resolves `auto`, and pricing the wrong model is
  wrong money with nothing red anywhere.
- Cached prompt tokens arrive as `prompt_tokens_details.cached_tokens` **or**
  `cache_read_tokens`, depending on the endpoint. Reading only one prices a
  cached prefix at full rate for ever.

**Never touched:** the runner, the gate, the verifier, the UI, the database.
`openai-protocol.ts` is the only file in the repository where an SDK type
appears, and that is checked by dependency-cruiser rather than by review.

## Adding a metric to the financial data

**Touches three files, and the SQL policy is not one of them.**

| Step | File                                                               |
| ---- | ------------------------------------------------------------------ |
| 1    | `data/financial_data.sql` (plus a migration if the table has rows) |
| 2    | `packages/grounding/src/display.ts` — only if it is not money      |
| 3    | `evals/golden/` — a case that uses it                              |

There is no column allowlist to update. The policy is an allowlist of _parse
tree keys_, a column that does not exist is refused by PostgreSQL itself, and
`llm_reader` can `SELECT` exactly one table.

There is no prompt to update either. `SemanticCatalogBuilder` reads
`information_schema` every ten minutes, so the new column appears on its own,
and `coverageOf` hands its unit to `packages/grounding`. That is the return on
never writing coverage down.

What does need thought is `display.ts`: it separates units, and a metric that is
money but in single dollars — earnings per share — formatted as `$1B` is wrong
in the direction nobody checks.

## Adding an SSE event

**Touches five files, and step 3 is the one people forget.**

| Step | File                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 1    | `packages/contracts/src/sse/stream-events.contract.ts` — a variant in the union                           |
| 2    | `generation/application/agent-events.ts` and `agent-runner.ts` — produce it                               |
| 3    | `generation/application/run-generation.use-case.ts` — `toStreamEvent` decides whether it reaches a client |
| 4    | `apps/web/src/domains/conversation/hooks/generation.state.ts` — a case in `applyEvent`                    |
| 5    | `apps/web/src/domains/conversation/components/ToolCall.tsx`, or wherever it is drawn                      |

Nothing forces step 3. The reducer ends in `default: return view` **on purpose**:
an old tab must survive a newer server sending an event it has never heard of,
which is the first rule of SSE here. An `assertNever` there would break exactly
the compatibility the union exists to provide. So an event that is produced but
never mapped in `toStreamEvent` simply vanishes, with nothing red.

The contract snapshot will tell you what you did:

```text
[additive] streamEvent(type=tool_progress) — a variant was added
```

Then `pnpm contracts:snapshot` and commit the file.

**Deploy order:** the server may always go first. The other way round means a
client waiting for an event the server has not learned to send.

## Adding a bounded context

**Touches four files plus the new context.** M9 did half of this for real.

| Step | File                                                                    |
| ---- | ----------------------------------------------------------------------- |
| 1    | `apps/api/src/<name>/{domain,application,infrastructure,presentation}/` |
| 2    | `apps/api/src/app.module.ts` — import it                                |
| 3    | The consuming context declares its **own** narrow port                  |
| 4    | The composition root binds that port to the new use case                |

Step 3 is the rule. A context never imports another's internals —
dependency-cruiser's `no-cross-context` fails the build for it. `GenerationBudget`
in the generation context and `ReserveBudgetUseCase` in the budget context are
the worked example, joined in `app.module.ts` by:

```ts
type _ReserverIsTheBudgetAConversationAsksFor = Assert<
  ReserveBudgetUseCase extends GenerationBudget ? true : false
>;
```

That line exists because `useExisting` on a token is not type-checked. Without
it, a renamed method is a 500 at runtime — which is how it was found.

## Adding a chart type

**Touches three files.**

| Step | File                                                                                   |
| ---- | -------------------------------------------------------------------------------------- |
| 1    | `packages/contracts/src/domain-view/chart-spec.ts` — a variant and `CHART_BLOCK_SHAPE` |
| 2    | `apps/web/src/domains/conversation/components/ChartBlock.tsx` — draw it                |
| 3    | `evals/golden/` — a case that produces one                                             |

The prompt already imports `CHART_BLOCK_SHAPE`, so what the model is told is
generated from the schema and needs no edit. `ChartBlock.tsx` is a ternary
today: make it a `switch` with `assertNever` **first**, so the third type is a
compile error rather than a blank panel.

---

## Changing a contract

`packages/contracts` is the boundary between two deployables. The snapshot gate
classifies every change:

| Verdict          | Red? | Example                                                   |
| ---------------- | ---- | --------------------------------------------------------- |
| `additive`       | no   | an optional field, a new SSE event, a wider request enum  |
| `deploy-ordered` | no   | a new **required** field in a response — server first     |
| `breaking`       | yes  | a removed field, a changed type, a required request field |

Anything the classifier has not been taught is **breaking**. That is the only
default that fails towards a person looking at it.

```bash
pnpm contracts:snapshot                              # record a safe change
CONTRACTS_ALLOW_BREAKING=1 pnpm contracts:snapshot   # and you meant this one
```

The gate cannot see a `.refine`. `messageView`'s rule — a verification report is
present exactly when an assistant message is complete — has no JSON Schema
spelling, so it is held by the type, by `message.spec.ts` and by a `CHECK`
constraint instead. A green snapshot is not evidence of it.

## Changing what a question is allowed to be

A question is stripped of invisible characters once, at the door
(`asModelSafeText` in `StartGenerationUseCase`), and never again — so what is
stored, shown back, used as the conversation's title and read by the model are
one string. Sanitising further downstream is how those four come to differ.

Nothing **visible** is changed, including text that looks like an attack.
`<|im_start|>` stays `<|im_start|>`, because mangling what somebody typed makes
the screen and the row disagree — and because that is not what stops it.
Nothing here builds a prompt by concatenation, so there is no template to
close, and what stops the attack that matters, a figure with nothing behind it,
is the claim gate, which does not care whether the model was fooled.

Prove that rather than assume it:
`apps/api/src/generation/__tests__/prompt-injection.spec.ts` runs twenty
payloads through the real runner, the real SQL policy, the real gate and the
real verifier, with a model that **did what the injection asked**. Adding a
payload is one entry in an array.

## Changing the database

`apps/api/drizzle/README.md` has the whole of it. In short: read the SQL
`drizzle-kit` wrote, write the note beside it, and expect `pnpm check` to fail
until the note matches what the file actually locks.

## What to do instead

| Tempting                                             | Why it is a trap                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A special case in `AgentRunner` for one tool         | That is what `AgentTool` is for. If a tool cannot be added without editing the runner, the port is wrong           |
| Parsing SQL outside `PgAstSqlPolicy`                 | Two answers to "what may run", and the second one is the one that gets it wrong                                    |
| A number formatted anywhere but `packages/grounding` | The formatter and the verifier must agree by construction, not by luck                                             |
| `assertNever` in the SSE reducer                     | It breaks forward compatibility, which is the point of the union                                                   |
| A `float` anywhere near the budget                   | `MicroUsd` exists because `0.1 + 0.2 !== 0.3`                                                                      |
| A `pg.Pool` without an `error` listener              | A connection that dies while idle ends the Node process. Measured: stopping Postgres under a running API killed it |
| A counter keyed on anything from a request           | `Counters` takes a name from a closed union and a label from a fixed set, for the reason `LogContext` does         |
| An e2e test that asserts what the model said         | That is `pnpm eval:live`, which reports. The browser suite asserts the machinery around the answer                 |
| Reading coverage from a constant                     | It comes from the database at runtime, so reseeding moves the prompt, the refusals and the verifier together       |
