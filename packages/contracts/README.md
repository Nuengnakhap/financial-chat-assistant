# `@fca/contracts`

One definition of every HTTP body and every SSE event, imported by both the API
and the web client. Depends on `zod` and nothing else.

The point is that a path, a verb and a payload shape exist once. The API binds
its handlers to these schemas instead of declaring DTOs, and the client builds
its typed calls from the same objects, so a renamed field breaks the build on
both sides in the same commit rather than at runtime on one of them.

## Layout

| Path                 | Holds                                                           |
| -------------------- | --------------------------------------------------------------- |
| `primitives.ts`      | `uuid`, `microUsd`, `cursor`, pagination and page envelopes     |
| `domain-view/`       | What the client renders: message parts, grounding report, views |
| `http/*.contract.ts` | Method, path and schemas per endpoint                           |
| `sse/`               | The discriminated union of stream events                        |

`domain-view` holds _views_, not entities. They are shaped for a client to
render and are free to differ from what the database stores.

## Three rules the tests enforce

**Every route is versioned from the first release.** Adding `/v2` later is
cheap; adding a version to an unversioned API means changing every caller. A
test asserts every path starts with `/api/v1/`.

**An unknown event is skipped, not fatal.** `parseStreamEvent` returns `null`
for anything it cannot read, so a server that starts sending a new event does
not break tabs that are already open. Adding an event is therefore always safe;
changing what an existing one means never is, because old clients keep reading
it the old way.

## Money on the wire

Amounts cross as an integer count of micro-USD **in a string** — `costMicroUsd`,
`spentMicroUsd`, and so on. JSON numbers are doubles, so a value sent as
`0.0014` and summed on the other side loses the exactness the budget path is
built to keep. `MicroUsd.toJSON()` already produces exactly this form.

The client converts to dollars for display only, at the last moment.

**A complete assistant message always carries its evidence.** `messageView`
refuses a payload where `status` is `complete` and `verification` is `null`, or
where a report is attached to a message that never finished. It is the wire form
of the same rule the database will hold as a `CHECK`, so a finished answer and a
checked answer are the same object at every layer.

## Status codes are data

Each route carries the status it answers with, so "this one replies 202 because
the work outlives the response" is something a handler and a test can read
rather than a sentence in a comment. Three routes are 202: deleting a
conversation runs a pipeline, and starting or stopping a generation hands off to
a runner.

## Usage

```typescript
import { messagesContract, parseStreamEvent } from '@fca/contracts';

const body = messagesContract.startGeneration.body.parse(request.body);

for await (const raw of stream) {
  const event = parseStreamEvent(raw);
  if (event === null) continue; // newer server, older client
}
```
