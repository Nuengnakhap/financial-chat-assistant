import { Injectable } from '@nestjs/common';

import type { AgentTool } from '../application/ports/agent-tool.port';
import type { QueryOutcome } from '../application/ports/tool-outcome';
import { COVERAGE_TOOL } from '../application/prompt.factory';
import { coverageReport, type SemanticCatalog } from '../application/semantic-catalog';
import { SemanticCatalogService } from '../application/semantic-catalog.service';

/**
 * The second tool, and the reason there is a registry.
 *
 * It exists because of one rule in the prompt: before saying this dataset does
 * not have something, query for it anyway, since a sentence about what the
 * dataset holds is itself a claim about the dataset and an answer is only
 * allowed to rest on tool results. Being *told* the coverage in the system
 * prompt is not evidence of it — nothing the model was told is — so until now
 * every "we do not have that" cost a round trip to the database to fetch an
 * empty result whose only content was its emptiness.
 *
 * This answers the same question directly, out of the catalog that was read for
 * the prompt, and the figures in it are evidence in exactly the way a query's
 * are: `49` companies and `2022`–`2025` are cells in a result, so an answer that
 * says them is supported and an answer that says fifty is not.
 *
 * What it answers with — the columns, the row and the statement they came from —
 * is worked out in `semantic-catalog.ts`, because the same column names have to
 * be registered in `Coverage`: one of them left unregistered would be a count
 * the verifier accepts as evidence for a dollar figure.
 */

@Injectable()
export class DescribeCoverageTool implements AgentTool {
  readonly definition = COVERAGE_TOOL;

  constructor(private readonly catalog: SemanticCatalogService) {}

  execute(toolCallId: string): Promise<QueryOutcome> {
    const catalog = this.catalog.current();
    if (catalog === null) return Promise.resolve(notYetRead(toolCallId));

    return Promise.resolve(coverageOutcome(toolCallId, catalog));
  }
}

function coverageOutcome(toolCallId: string, catalog: SemanticCatalog): QueryOutcome {
  const report = coverageReport(catalog);

  return {
    toolCallId,
    sql: report.sql,
    columns: report.columns,
    rows: [report.row],
    display: new Map(),
    rowCount: 1,
    truncated: null,
    elapsedMs: 0,
    fromCache: true,
    failure: null,
  };
}

/**
 * Before the first read, or while the database has been unreachable since the
 * process started. A generation cannot begin without a catalog at all, so this
 * is all but unreachable — and it is a failure the model can act on rather than
 * an exception, like every other failure a tool can have.
 */
function notYetRead(toolCallId: string): QueryOutcome {
  return {
    toolCallId,
    sql: null,
    columns: [],
    rows: [],
    display: new Map(),
    rowCount: 0,
    truncated: null,
    elapsedMs: 0,
    fromCache: false,
    failure: {
      kind: 'database',
      message: 'The coverage of this dataset could not be read. Query the table instead.',
    },
  };
}
