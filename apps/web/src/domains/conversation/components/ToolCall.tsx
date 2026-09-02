import type { MessagePart, ToolResultRow } from '@fca/contracts';

/**
 * The query behind an answer, shown as it happens.
 *
 * This is the part of the interface that makes the guarantee visible: the
 * figures above it came from this statement, run against this data, and the
 * statement is the deparsed form the database actually received rather than
 * anything the model typed. Somebody who does not believe a number can read the
 * query that produced it and the rows it came back with.
 *
 * Open by default while it runs and closed once it has, because a finished
 * query is provenance rather than progress — there when it is wanted, and not
 * in the way of the answer when it is not.
 */

type Call = Extract<MessagePart, { kind: 'tool_call' }>;
type Result = Extract<MessagePart, { kind: 'tool_result' }>;

export interface ToolCallProps {
  readonly call: Call;
  /** Absent while the query is still running. */
  readonly result: Result | undefined;
}

export function ToolCall({ call, result }: ToolCallProps) {
  return (
    <details open={result === undefined} className="my-4 rounded-md border border-line bg-panel">
      <summary className="flex cursor-pointer items-center gap-3 px-3 py-2 font-mono text-micro tracking-wide text-muted uppercase">
        <span>Query</span>
        <Status result={result} />
      </summary>
      <div className="border-t border-line px-3 py-3">
        <pre className="overflow-x-auto font-mono text-caption whitespace-pre-wrap text-text">
          {call.sql}
        </pre>
        {result !== undefined && <Answered result={result} />}
      </div>
    </details>
  );
}

function Status({ result }: { readonly result: Result | undefined }) {
  if (result === undefined) return <span className="text-muted">running…</span>;
  if (result.error !== null) return <span className="text-negative">refused</span>;

  return (
    <span className="fin-num text-muted">
      {result.rowCount} {result.rowCount === 1 ? 'row' : 'rows'} · {result.elapsedMs}ms
    </span>
  );
}

function Answered({ result }: { readonly result: Result }) {
  // The reason a query was refused, in the words the policy chose. It is the
  // model that has to act on it — this is here so a person watching can see
  // that something was refused rather than silently skipped.
  if (result.error !== null) {
    return <p className="mt-3 text-body-sm text-muted">{result.error}</p>;
  }
  if (result.preview.length === 0) {
    return <p className="mt-3 text-body-sm text-muted">No rows matched.</p>;
  }

  return <Preview rows={result.preview} total={result.rowCount} />;
}

function Preview({
  rows,
  total,
}: {
  readonly rows: readonly ToolResultRow[];
  readonly total: number;
}) {
  const columns = Object.keys(rows[0] ?? {});

  return (
    <div className="mt-3">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-caption">
          <Head columns={columns} />
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-b border-line last:border-0">
                {columns.map((column) => (
                  <Cell key={column} value={row[column]} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length < total && (
        <p className="mt-2 text-micro text-muted">
          Showing {rows.length} of {total} rows.
        </p>
      )}
    </div>
  );
}

function Head({ columns }: { readonly columns: readonly string[] }) {
  return (
    <thead className="border-b border-line">
      <tr>
        {columns.map((column) => (
          <th
            key={column}
            className="py-1 pr-4 text-left font-mono text-micro tracking-wide text-muted uppercase last:pr-0"
          >
            {column}
          </th>
        ))}
      </tr>
    </thead>
  );
}

/**
 * A missing figure says so in words rather than as a blank: nothing recorded is
 * a fact about this dataset, and an empty cell reads as a rendering fault.
 */
function Cell({ value }: { readonly value: ToolResultRow[string] | undefined }) {
  if (value === null || value === undefined) {
    return (
      <td title="Not recorded in this dataset" className="py-1 pr-4 text-muted last:pr-0">
        —
      </td>
    );
  }

  const figure = /^-?\d+(\.\d+)?$/.test(String(value));

  return <td className={`py-1 pr-4 last:pr-0${figure ? ' fin-num' : ''}`}>{String(value)}</td>;
}

/**
 * The statement as the model types it, before it is a call that can be run.
 * Watching a query take shape is the clearest thing this interface does: it is
 * the moment the assistant stops being a box that answers and becomes something
 * doing work that can be checked.
 */
export function WritingQuery({ sql }: { readonly sql: string }) {
  return (
    <div className="my-4 rounded-md border border-line bg-panel px-3 py-2">
      <p className="font-mono text-micro tracking-wide text-muted uppercase">Writing a query</p>
      <pre className="mt-2 overflow-x-auto font-mono text-caption whitespace-pre-wrap text-muted">
        {sql}
        <Caret />
      </pre>
    </div>
  );
}

/**
 * The one moving thing on the page. Nothing here turns it off for somebody who
 * asked for less motion — the reduced-motion rule in `tokens.css` applies to
 * every animation there is, so a component opting out again would be a second
 * place for that decision to live.
 */
export function Caret() {
  return (
    <span aria-hidden="true" className="ml-1 animate-caret">
      ▍
    </span>
  );
}
