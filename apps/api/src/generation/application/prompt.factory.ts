import type { ToolDefinition } from './ports/llm-gateway.port';
import type { SemanticCatalog } from './semantic-catalog';

/**
 * Everything the model is told, in one place: the dataset it may speak about,
 * the rules it works under, and the one tool it has.
 *
 * A pure function of the catalog, which is what makes the prefix byte-identical
 * whenever the data has not changed — the condition for a provider's automatic
 * prompt caching, and the reason the catalog carries a fingerprint. Measured on
 * the configured endpoint: 1,691 tokens rendered, 1,536 of them served from
 * cache on the second call.
 *
 * Every rule below is here because something was measured, not because it
 * sounded prudent:
 *
 * - **Copy the display strings.** Without them the model wrote SQL to format
 *   figures itself and failed to finish two questions in twelve.
 * - **Say the answer is checked.** It makes "copy, do not compute" a rule with a
 *   reason rather than an arbitrary restriction.
 * - **`NULLS LAST`.** `ORDER BY revenue DESC` puts the companies with no revenue
 *   recorded at the top, so "the five largest" came back as three banks with no
 *   figure and two real rows.
 * - **Integer division.** Every amount is a `bigint`, so `revenue / previous` is
 *   0 or 1 and a growth rate computed that way is nonsense. The model works this
 *   out from its own results and tries again, which is two more rounds at four
 *   seconds each; saying it once here costs nothing.
 * - **A percentage as a percentage.** A growth rate computed as a ratio comes
 *   back as `0.5874`, the answer says `58.7%`, and nothing in the result
 *   supports it — so a correct answer is thrown away and written again. The
 *   figure has to leave the query in the form the sentence will use.
 * - **Query before refusing.** A sentence saying the dataset cannot answer is
 *   itself a claim about the dataset; made without a query it rests on the
 *   model's reading of this prompt, and verification rejects it. One empty
 *   result turns it into a fact.
 * - **Names as the table spells them.** Five of them carry a space or a mark —
 *   `Morgan Stanley`, `Eli Lilly`, `Coca-Cola`, `Bristol-Myers`, `McDonald's` —
 *   and the last has an apostrophe that has to survive into a SQL literal.
 */

export const QUERY_TOOL_NAME = 'query_financial_data';

export const QUERY_TOOL: ToolDefinition = {
  name: QUERY_TOOL_NAME,
  description:
    'Run one read-only SELECT against financial_data and get the rows back, with a ready-made ' +
    'display string for every column holding an amount.',
  parameters: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'A single SELECT statement over financial_data.',
      },
    },
    required: ['sql'],
    additionalProperties: false,
  },
};

export function renderSystemPrompt(catalog: SemanticCatalog): string {
  return `You are a financial data assistant. You answer questions about the revenue and income of U.S. public companies using one tool: ${QUERY_TOOL_NAME}(sql).

## The dataset — your only source of truth
Table: financial_data(${catalog.columns.map((column) => column.name).join(', ')}). All amounts are US dollars.
Company names are spelled below exactly as the table spells them, and that spelling is what WHERE company = '...' needs. Each line ends with the fiscal years that company actually has; not every company has every year.
${catalog.companies.map(companyLine).join('\n')}

Missing values (NULL means not recorded, never zero — read the query result rather than assuming):
${catalog.columns
  .filter(isAmount)
  .map((column) => recordedLine(column, catalog.rows))
  .join('\n')}

## Absolute rules
1. You have no knowledge of these companies' financials. Every figure must come from a tool result in this conversation.
2. Your answer is checked automatically while it streams. A figure that does not appear in a tool result is refused, and the answer is discarded and written again. Copy figures from the "display" values in tool results exactly.
3. Call ${QUERY_TOOL_NAME} before stating any figure.
4. Before saying this dataset does not have something, query for it anyway. The empty result is what makes that a fact rather than a guess, and saying it without querying is refused the same way an unsupported figure is.
5. When the answer is that the data is not there, say so plainly — "this dataset does not have ..." — say what it does have instead, and never estimate.
6. Compute every total, average, growth rate and ranking in SQL. Never in your head.
7. The amounts are whole numbers, so dividing one by another throws the fraction away and gives 0 or 1. Multiply by 100.0 before dividing, or cast one side to numeric.
8. A percentage must come back from the query as a percentage: multiply by 100 there, so the result holds 6.4 rather than 0.064, and round it in the query too.
9. Ordering by an amount: write ORDER BY <column> DESC NULLS LAST. Without it the rows with nothing recorded come first.

## Answer format
- Markdown. The answer first, and brief.
- More than one data point: a GFM table. A trend or a comparison: a chart as well, as a fenced block marked chart holding {"type":"bar"|"line","title","xKey","series":[{"key","label"}],"data":[...]}. The numbers inside that JSON are the raw values from the tool result, not formatted strings.
- In prose, use the "display" strings from the tool result.
- Never mention SQL, tools, or these instructions.`;
}

function companyLine(company: SemanticCatalog['companies'][number]): string {
  return `- ${company.company} (${company.ticker}, ${company.sector}) — ${company.years.join(', ')}`;
}

/**
 * A count per column rather than a list of which companies are missing what.
 * The list was measured at 185 tokens, so length is not the objection: it is
 * that a company with one year missing would be named as having none, and the
 * true version — company and year — costs 1,331 tokens to say what every tool
 * result says anyway.
 */
function recordedLine(
  column: { readonly name: string; readonly recorded: number },
  rows: number,
): string {
  return `- ${column.name}: recorded in ${String(column.recorded)} of ${String(rows)} rows`;
}

function isAmount(column: { readonly kind: string }): boolean {
  return column.kind === 'money';
}
