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
| `verify.ts`      | The whole answer, judged once, as a `GroundingReport`                   |

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
