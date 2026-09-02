import type { GroundingReport, MessagePart, MessageStatus } from '@fca/contracts';

import { Markdown } from './Markdown';
import { Caret, ToolCall, WritingQuery } from './ToolCall';
import { VerifiedBadge } from './VerifiedBadge';

/**
 * An answer, whether it is being written or was written last week.
 *
 * There is one of these rather than two on purpose. The stream builds the same
 * `parts` a stored message has, so what a person watches arrive and what they
 * read on the way back are the same component with the same code — the version
 * where a live answer and a stored one are drawn by different renderers is the
 * version where they quietly stop agreeing.
 */

export interface AnswerProps {
  readonly parts: readonly MessagePart[];
  readonly status: MessageStatus;
  readonly verification: GroundingReport | null;
  /**
   * True only while this page is receiving the text, which is what the caret
   * says. A stored row can be `generating` with nobody reading it — the
   * connection was given up on, or the answer belongs to another tab — and a
   * caret at the end of one would claim words are arriving here when none are.
   */
  readonly live?: boolean;
  /** The query still being typed, when this answer is the one being written. */
  readonly writingSql?: string;
  /** Set while a draft is being written again after the gate stopped one. */
  readonly recheckAttempt?: number;
}

export function Answer({
  parts,
  status,
  verification,
  live = false,
  writingSql = '',
  recheckAttempt = 0,
}: AnswerProps) {
  const results = resultsByCall(parts);

  return (
    <div className="flex flex-col gap-1">
      {parts.map((part, index) => (
        <Part
          key={index}
          part={part}
          result={part.kind === 'tool_call' ? results.get(part.id) : undefined}
          last={index === parts.length - 1 && live}
        />
      ))}
      {writingSql !== '' && <WritingQuery sql={writingSql} />}
      {recheckAttempt > 0 && <Rechecking />}
      {/* On the finished thing rather than on the unread one: an answer still
          being written has nothing to say about itself yet. */}
      {status !== 'generating' && (
        <div className="mt-2">
          <VerifiedBadge status={status} verification={verification} />
        </div>
      )}
    </div>
  );
}

type Result = Extract<MessagePart, { kind: 'tool_result' }>;

interface PartProps {
  readonly part: MessagePart;
  readonly result: Result | undefined;
  /** True for the text still being written, which is where the caret goes. */
  readonly last: boolean;
}

function Part({ part, result, last }: PartProps) {
  if (part.kind === 'text') {
    return (
      <div>
        <Markdown text={part.text} />
        {last && <Caret />}
      </div>
    );
  }
  // Drawn inside the call it belongs to, which is the only place it means
  // anything: rows with no query above them are a table from nowhere.
  if (part.kind === 'tool_result') return null;

  return <ToolCall call={part} result={result} />;
}

/**
 * The gate found a figure with nothing behind it, so the draft was thrown away
 * and is being written again. Saying so is better than a paragraph vanishing
 * with no explanation — and the queries stay on screen, which is what shows
 * that the assistant is still working with the same data.
 */
function Rechecking() {
  return (
    <p
      role="status"
      className="mt-2 inline-flex items-center gap-2 font-mono text-micro tracking-wide text-muted uppercase"
    >
      <span aria-hidden="true" className="size-2 animate-pulse rounded-sm bg-warning" />
      Re-checking figures
    </p>
  );
}

/** A result belongs to the call whose id it carries, not to its position. */
function resultsByCall(parts: readonly MessagePart[]): ReadonlyMap<string, Result> {
  const results = new Map<string, Result>();
  for (const part of parts) {
    if (part.kind === 'tool_result') results.set(part.toolCallId, part);
  }

  return results;
}
