import type { GroundingReport, MessagePart, MessageStatus } from '@fca/contracts';

import { Markdown } from './Markdown';
import { Caret, ToolCall, WritingQuery } from './ToolCall';
import { VerifiedBadge } from './VerifiedBadge';
import { useLiveText } from '../hooks/useLiveText';
import { sqlBeingWritten } from '../utils/writing-sql';

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
  /**
   * The tool call's arguments as they arrive — JSON, not SQL. What is drawn is
   * the statement inside them; see `sqlBeingWritten`.
   */
  readonly writingArgs?: string;
  /** Set while a draft is being written again after the gate stopped one. */
  readonly recheckAttempt?: number;
}

export function Answer({
  parts,
  status,
  verification,
  live = false,
  writingArgs = '',
  recheckAttempt = 0,
}: AnswerProps) {
  // The text still being written is the only part that changes, so it is the
  // only one drawn from `shown` rather than from `parts`: a burst leaving the
  // claim gate whole is revealed rather than dropped into a single frame.
  const writing = lastTextIn(parts);
  const { shown, waiting } = useLiveText(writing.text, live);
  // Read here rather than in the card, because both the card and the line below
  // it turn on the same question: is a query being written right now.
  const sql = sqlBeingWritten(writingArgs);
  const holding = isHolding({ waiting, live, recheckAttempt, writing, parts, writingArgs });

  return (
    <div className="flex flex-col gap-1">
      <Written parts={parts} live={live} writingIndex={writing.index} shown={shown} />
      {/* Not `writingArgs !== ''`: the first deltas of a call are `{`, `{"`,
          `{"sq`, and a tool that takes `{}` never has a statement at all — a
          card headed "Writing a query" over an empty box announces one that is
          not being written. */}
      {sql !== '' && <WritingQuery sql={sql} />}
      {recheckAttempt > 0 && <Rechecking />}
      {holding && <Holding />}
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

interface Writing {
  /** Where the text still being written sits; `-1` when none has arrived. */
  readonly index: number;
  readonly text: string;
}

interface HoldingProps {
  readonly waiting: boolean;
  readonly live: boolean;
  readonly recheckAttempt: number;
  readonly writing: Writing;
  readonly parts: readonly MessagePart[];
  readonly writingArgs: string;
}

/**
 * Whether the silence is a held block rather than something else.
 *
 * Only after prose that stopped mid-answer: the gate holds a table and a fenced
 * block whole, and that is the one wait this page can name. A silence before
 * anything is written is the model thinking, a silence while a query is being
 * typed is the card above it, and a silence during a rewrite has its own line.
 */
function isHolding({
  waiting,
  live,
  recheckAttempt,
  writing,
  parts,
  writingArgs,
}: HoldingProps): boolean {
  // `writing.index` is -1 when no text has arrived, and so is `parts.length - 1`
  // when nothing has. Comparing the two alone made the line appear under
  // "Writing a query" before a word had been written.
  if (parts.length === 0 || writing.index !== parts.length - 1) return false;
  // A call's arguments arrive while the last part is still the prose before it,
  // so a query taking thirteen seconds to type reads here as a silence. It is
  // one — but it is the card's silence, and two lines claiming the screen at
  // once, one of them saying "nothing shows" beside something being shown, is
  // worse than either alone.
  if (writingArgs !== '') return false;

  return waiting && live && recheckAttempt === 0;
}

interface WrittenProps {
  readonly parts: readonly MessagePart[];
  readonly live: boolean;
  /** Where the text still being written sits, if any of it has arrived. */
  readonly writingIndex: number | undefined;
  readonly shown: string;
}

/** Everything that has been written, in the order it was written. */
function Written({ parts, live, writingIndex, shown }: WrittenProps) {
  const results = resultsByCall(parts);

  return (
    <>
      {parts.map((part, index) => (
        <Part
          key={index}
          part={part}
          result={part.kind === 'tool_call' ? results.get(part.id) : undefined}
          last={index === parts.length - 1 && live}
          text={live && index === writingIndex ? shown : undefined}
        />
      ))}
    </>
  );
}

type Result = Extract<MessagePart, { kind: 'tool_result' }>;

interface PartProps {
  readonly part: MessagePart;
  readonly result: Result | undefined;
  /** True for the text still being written, which is where the caret goes. */
  readonly last: boolean;
  /** As much of this text as has been revealed, for the one part still growing. */
  readonly text?: string | undefined;
}

function Part({ part, result, last, text }: PartProps) {
  if (part.kind === 'text') {
    return (
      <div>
        <Markdown text={text ?? part.text} />
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

/**
 * Nothing has arrived for over a second, which on this page usually means one
 * thing: the claim gate is holding a table or a fenced block whole, because a
 * number in a leading cell is only a rank once the row count is known.
 *
 * Saying so is the whole point. A screen that has not changed for thirteen
 * seconds reads as broken; the same screen with a line explaining that nothing
 * is shown until its figures check out reads as the product doing its job.
 */
function Holding() {
  return (
    <p
      role="status"
      className="mt-2 inline-flex items-center gap-2 font-mono text-micro tracking-wide text-muted uppercase"
    >
      <span aria-hidden="true" className="size-2 animate-pulse rounded-sm bg-muted" />
      Still writing — nothing shows until its figures check out
    </p>
  );
}

/** The last text part and where it sits, which is the one still being written. */
function lastTextIn(parts: readonly MessagePart[]): Writing {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.kind === 'text') return { index, text: part.text };
  }

  return { index: -1, text: '' };
}

/** A result belongs to the call whose id it carries, not to its position. */
function resultsByCall(parts: readonly MessagePart[]): ReadonlyMap<string, Result> {
  const results = new Map<string, Result>();
  for (const part of parts) {
    if (part.kind === 'tool_result') results.set(part.toolCallId, part);
  }

  return results;
}
