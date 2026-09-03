# `@fca/grounding`

The layer that decides whether a figure in an answer is true, with no framework
attached. Nothing here imports NestJS, Drizzle, `pg`, `ioredis`, React or an HTTP
library, which the `no-framework-in-packages` rule in `.dependency-cruiser.cjs`
enforces rather than trusting. Every function is pure: the same answer and the
same query results always produce the same verdict, and every verdict can be
reproduced from a fixture without a network, a database or a model.

## What lives here

| Module           | Responsibility                                                          |
| ---------------- | ----------------------------------------------------------------------- |
| `quantity.ts`    | An exact rational. Nothing in this package uses a float                 |
| `display.ts`     | What a written figure means, and the string a tool result hands over    |
| `tool-result.ts` | A query result in the shape the model was shown it                      |
| `evidence.ts`    | What the results prove, and where each thing was proved                 |
| `claims.ts`      | Which figures in an answer are claims about the data, and which are not |
| `coverage.ts`    | What the dataset holds, as much of it as deciding a figure needs        |
| `judgement.ts`   | What one figure turns out to be — the single rule both callers ask      |
| `verify.ts`      | The whole answer, judged once, as a `GroundingReport`                   |
| `gate.ts`        | The filter the answer is written through, one delta at a time           |
| `repair.ts`      | What to do with a draft that failed, and what to tell the model         |
| `fallback.ts`    | The answer of last resort, assembled from the rows alone                |

Import from the package root (`@fca/grounding`). Deep imports are not part of the
public surface and the file layout is free to change underneath them.

## The rules this package exists to enforce

**Formatting and tolerance are one decision.** A display string does not name a
value, it names the interval of values that would have produced it: `$97.0B` is
every amount that rounds to 97.0 at one decimal of a billion. Read that way, the
tolerance rule is the formatter read backwards, so a figure the model copied out
of a tool result is inside its own interval by construction. A property test over
five thousand values holds `formatUsd` and `bandOf` to that.

**The interval is closed at both ends.** Six values in this dataset land exactly
on a rounding boundary — Tesla's 2024 gross profit of 17,450,000,000 is one — and
each is inside the interval of both neighbouring strings. Narrowing this to
`[low, high)` to look stricter turns a correct figure into a violation. There is
a test named for that, holding six real values, so the change fails loudly.

**Support is a place, not a boolean.** Half the display strings this dataset
produces stand for an interval that covers some other real value too: `$10.6B` is
AMD's 2022 gross profit, Coca-Cola's 2024 net income and Eli Lilly's 2024 net
income at once. `EvidenceSet.match` returns every place a figure could have come
from, nearest value first, which is what lets the report point at a row instead
of inventing one. The order is part of the contract: returning them by value
would name Eli Lilly for that `$10.6B` every time, biasing every provenance
towards the bottom edge of its interval. It also fixes what that provenance is
allowed to claim. `toolCallId`, `rowIndex` and
`column` mean _a cell that supports this figure_, never _the cell the model was
looking at_. Nothing in a finished string can prove the second.

**No float, anywhere.** An average is a sum over a count and a growth rate is a
difference over a base, and neither is an integer. Computing either in a `number`
puts a rounding error at exactly the resolution the tolerance rule is deciding
on. `Quantity` is a reduced rational in `bigint`, and comparison cross-multiplies
rather than dividing, so equality is equality.

**Half the numbers in an answer are not claims.** Of sixty-one numeric tokens
across twelve answers from the configured model, twenty-eight were years or a
table's rank column. So the split is made from shapes that were measured rather
than guessed, and it is narrow: a bare count in prose stays a claim, because
`COUNT(*)` puts the real number in the results and the difference between 48
companies and 49 is the thing most likely to be wrong.

**Some things are deliberately not evidence.** Growth from a negative base has
two defensible formulas that disagree about the sign — Intel going from −18.76B
to −0.27B is either −98.6% or +98.6% — so supporting both would let a figure and
its negation pass the same check. An answer about a loss is expected to state the
two amounts, which are cells. Pairwise differences and growth rates stop being
precomputed above twelve rows, where a result is a table somebody reads rather
than a comparison somebody narrates, because every extra value in the set is
another interval a fabricated figure could land in by chance.

**The gate and the verifier cannot disagree, by construction.** Checking a
finished answer is too late to be the guarantee — by then an unsupported figure
has been on somebody's screen, and correcting it afterwards does not unsee it. So
the gate decides each figure the moment it is complete and holds it until then.
That only works if the two readings agree, and they are not two readings: there
is one `judge`, and the gate and the verifier differ solely in _when_ they call
it. The gate releases text only once the extractor's reading of it can no longer
change, so where a delta happened to begin or end is invisible to it. A property
test cuts an answer into two thousand different chunkings and gets the same bytes
out every time, but the reason it passes is the design, not the test.

Held means held even when the window has already been narrowed for another
reason. While no query has run the gate releases only up to the last line break,
and a figure that begins inside that reach and ends past it fits in neither — it
was the case where `$999.9B` reached a screen, in a build whose property tests
all passed, because every generated case had evidence and so never narrowed the
window. The reach and the hold are now separate steps: whatever the window is,
the release point moves back to the start of the first claim that does not fit
inside it.

Two shapes need more than a line before they can be read: a table, because a
number in its leading cell is a rank only if it falls inside the row count the
table ends up having, and a fenced block, because a fence means whatever its
closing line says it meant. Both are held whole. Neither renders half-finished
anyway, so the hold costs a reader nothing — but it does mean the "at most a few
characters held" promise applies to prose and not to those.

**A figure is not the only thing that can be a claim.** Saying this dataset
cannot answer is one too, and one made without running a query rests on nothing
that happened. A gate watching only numbers would let "…is not availabl" appear
on screen and leave the verifier to object afterwards, which is the failure this
whole layer exists to avoid — so while no query has run, the tail of the answer
is held back far enough for that sentence to finish inside it. The easy version
of this, holding everything whenever nothing was queried, is the wrong one: a
clarifying question claims nothing and should flow.

**Giving up is a designed outcome, not a missing one.** A draft that fails is
told exactly which figures failed and why, and asked again — twice, because a
model that has had precise feedback twice is failing at something being told does
not reach. After that the reader still gets the figures: a table built from the
rows themselves, with a sentence saying there is no summary around it. That is
what makes the guarantee total rather than likely. There is no path where an
unchecked figure reaches a reader, because the path that gives up shows only
rows — and that table is put through the same verifier the drafts were, so an
answer this package wrote is not exempt from the rule it exists to enforce. When
even the table fails, what is offered is a sentence with no figures in it. The
last resort has a last resort.

The repair instruction names the failures and stops there. It could carry the
right value — the evidence knows it — and deliberately does not: the report is a
text and a reason by design, and a system that fills in the correct figure and
then calls the model's output verified has verified nothing.

**A refusal to check is stated, not hidden.** Two checks that sound obvious
cannot be decided from text without being wrong more often than right, so each is
reduced to the part that can be, and the reduction is written down beside the
code rather than left as a gap somebody later reads as an oversight. Company
coverage is not checked in prose, because
"Berkshire Hathaway's 2023 net income is not available in this dataset" names a
company outside the catalog and is the correct answer — and the guarantee holds
anyway, since a company outside it returns no rows and any figure attributed to
one has nothing supporting it. A chart plotted under the wrong label is likewise
invisible here: every number in it is real and only the pairing is wrong, which
needs the chart's structure rather than the numbers in it.

**Every reason is one a repair round can act on.** `no_evidence` and
`value_mismatch` are not two words for the same failure: a figure one display
string away from a real value is a misread digit and can be corrected, while one
near nothing at all was invented, and asking for an adjustment there would invite
a second guess. `unit_mismatch` is what stops `$2,023` finding its evidence in
the year column beside the money. `out_of_coverage` is what a year the dataset
does not hold gets instead of being called a missing figure.

## Tests

Tests live in a `__tests__` directory beside the code they cover, enforced by the
`tests-live-in-tests-folder` rule. Several are anchored to figures that came out
of the real table or out of a real answer — including the growth rate the
configured model stated as `300.0%` when it was `384.9%`, which is what a gate
built on prompt rules alone would have let through.
