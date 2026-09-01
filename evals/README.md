# `evals/`

The quality gate on grounding. Run it with `pnpm eval`; it also runs inside
`pnpm test`, so the gate cannot be forgotten by anyone who only runs the tests.

```bash
pnpm build && pnpm eval
```

The build comes first because the eval consumes `@fca/grounding` through its
published entry point, exactly as the API will — a break in that surface shows up
here as well as in the package's own tests.

## What it measures

| Metric             | Gate                                        |
| ------------------ | ------------------------------------------- |
| Verdict accuracy   | 100% — every case reaches the right verdict |
| Reason accuracy    | 100% — wherever a case names a reason       |
| Gate agreement     | 100% — see below                            |
| Unavailable recall | **100%, no tolerance**                      |
| p95 verification   | under 15 ms                                 |

The numbers are printed as well as asserted, because a suite that has slipped
from a hundred per cent to ninety-six is worth seeing before it crosses whatever
threshold was written down.

**Unavailable recall is the one with no tolerance.** Saying something confident
about data that is not in this dataset is the worst failure available to the
system, so it is the failure allowed none. The gate has been shown to go red:
removing the check on refusals made without querying takes it to 87.5%.

**Gate agreement** compares the two readings of every answer — the streaming gate
releasing it a chunk at a time and the verifier judging it whole. An answer the
verifier accepts must come out of the gate intact; one it rejects must have been
stopped rather than shown. The exception is a case failing on a property of the
whole answer rather than of a figure — a chart plotting something the prose never
mentions — which the gate cannot see one figure at a time. Those cases are marked
in the corpus, and what they cost is a repair round, never a false figure: every
number the gate released was supported.

## What it does not measure

Repair rate and fallback rate are how often a real draft has to be written again,
and this suite has no drafts: it is deterministic, with recorded query results, no
model, no network and no database. Those two arrive with the generation pipeline.
Printing a placeholder for them would be worse than leaving them out.

## The corpus

`golden/results.ts` holds query results recorded from the real table, chosen so
that every trap the dataset is known for is present: negative values, one of them
small enough to change scale; a company whose recorded revenue is a quarter of
what the world believes; columns that are `NULL` rather than zero; averages that
come back with eight decimals; three companies whose figures share one display
string; a value exactly on a rounding boundary; and the two companies that do not
have all four years.

`golden/cases.ts` pairs those with answers. The written cases carry real
phrasing — several word for word from the configured model, including the growth
rate it stated as `300.0%` when the rows say `384.9%` — and pin the exact reason a
figure is refused, because a verdict that is right for the wrong reason tells a
repair round to fix the wrong thing. The generated cases pair every recorded
result with a grounded answer and a fabricated one in four shapes — prose, a
table, a chart fence and a full-precision figure — and pin only the verdict; what
they buy is breadth over real values in every place an answer can put a number.

The fabricated figures are in trillions, beyond anything these results could
support. If one of them ever does find support, the suite fails rather than
passing quietly.
