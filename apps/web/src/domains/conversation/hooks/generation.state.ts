import type { GroundingReport, MessagePart, StreamEvent } from '@fca/contracts';

import type { StreamFrame } from '@/lib/api/sse';

/**
 * What a generation looks like on screen, as a pure function of what has
 * arrived.
 *
 * It is a reducer and nothing else: no store, no cache, no effects. The state
 * lives exactly as long as the page does and nobody else reads it, so a store
 * would be a part with no second reader. Every transition is total — an event
 * this build does not expect, or one that arrives in a phase where it makes no
 * sense, is ignored rather than thrown, because a stream is the one place where
 * an older tab meets a newer server.
 */

interface StreamingView {
  /**
   * The same shape a stored message has, so one renderer draws the answer being
   * written and the answer in the history. There is one of it, not two.
   */
  readonly parts: readonly MessagePart[];
  /** The tool call's arguments as they arrive: JSON, not SQL. */
  readonly writingArgs: string;
  readonly verification: GroundingReport | null;
  /** Above zero while a draft is being written again after the gate stopped one. */
  readonly recheckAttempt: number;
}

export type GenerationState =
  | { readonly phase: 'idle' }
  /** The question is on screen and the command is in flight. */
  | { readonly phase: 'starting'; readonly question: string }
  | {
      readonly phase: 'streaming';
      readonly assistantMessageId: string;
      /** Empty when this page did not ask — a resumed answer, whose question is history. */
      readonly question: string;
      readonly lastEventId: string | null;
      readonly view: StreamingView;
    }
  | {
      readonly phase: 'reconnecting';
      readonly assistantMessageId: string;
      readonly question: string;
      readonly lastEventId: string | null;
      readonly view: StreamingView;
      readonly attempt: number;
    }
  /** Written for a person: whatever the server said, never an exception. */
  | { readonly phase: 'failed'; readonly message: string };

export type GenerationAction =
  | { readonly type: 'ask'; readonly question: string }
  | { readonly type: 'watch'; readonly assistantMessageId: string }
  | { readonly type: 'frame'; readonly frame: StreamFrame }
  | { readonly type: 'dropped'; readonly attempt: number }
  | { readonly type: 'resumed' }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'idle' };

export const IDLE: GenerationState = { phase: 'idle' };

const EMPTY_VIEW: StreamingView = {
  parts: [],
  writingArgs: '',
  verification: null,
  recheckAttempt: 0,
};

/** True while the composer must not accept another question. */
export function isBusy(state: GenerationState): boolean {
  return state.phase !== 'idle' && state.phase !== 'failed';
}

/** The message being written, when there is one to stop. */
export function generatingId(state: GenerationState): string | null {
  return state.phase === 'streaming' || state.phase === 'reconnecting'
    ? state.assistantMessageId
    : null;
}

export function reduce(state: GenerationState, action: GenerationAction): GenerationState {
  switch (action.type) {
    case 'ask':
      return { phase: 'starting', question: action.question };
    case 'watch':
      return {
        phase: 'streaming',
        assistantMessageId: action.assistantMessageId,
        // Held for the whole generation rather than read back from the history:
        // the question and its answer become rows together at the end, so until
        // then this is the only place the question is.
        question: questionOf(state),
        lastEventId: null,
        // Kept when the same generation is being watched again, so a reconnect
        // does not clear what the person is already reading.
        view: viewOf(state, action.assistantMessageId),
      };
    case 'frame':
      return applyFrame(state, action.frame);
    case 'dropped':
      return state.phase === 'streaming'
        ? { ...state, phase: 'reconnecting', attempt: action.attempt }
        : state;
    case 'resumed':
      return state.phase === 'reconnecting'
        ? {
            phase: 'streaming',
            assistantMessageId: state.assistantMessageId,
            question: state.question,
            lastEventId: state.lastEventId,
            view: state.view,
          }
        : state;
    case 'failed':
      return { phase: 'failed', message: action.message };
    case 'idle':
      return IDLE;
  }
}

/** Empty for an answer this page is only watching: its question is already a row. */
function questionOf(state: GenerationState): string {
  if (state.phase === 'starting') return state.question;

  return state.phase === 'streaming' || state.phase === 'reconnecting' ? state.question : '';
}

function viewOf(state: GenerationState, assistantMessageId: string): StreamingView {
  const watching = state.phase === 'streaming' || state.phase === 'reconnecting';

  return watching && state.assistantMessageId === assistantMessageId ? state.view : EMPTY_VIEW;
}

/**
 * A frame moves the cursor and the view together. The cursor moves for every
 * event that has a position, including ones this view does nothing with — the
 * point of it is to say what has been seen, not what has been drawn.
 */
function applyFrame(state: GenerationState, frame: StreamFrame): GenerationState {
  if (state.phase !== 'streaming' && state.phase !== 'reconnecting') return state;

  return {
    ...state,
    lastEventId: frame.id ?? state.lastEventId,
    view: applyEvent(state.view, frame.event),
  };
}

function applyEvent(view: StreamingView, event: StreamEvent): StreamingView {
  switch (event.type) {
    case 'text_delta':
      return { ...view, parts: withText(view.parts, event.delta) };
    case 'tool_call_delta':
      return { ...view, writingArgs: view.writingArgs + event.argsDelta };
    case 'tool_call_ready':
      return {
        ...view,
        writingArgs: '',
        parts: [...view.parts, { kind: 'tool_call', id: event.id, sql: event.sql }],
      };
    case 'tool_result':
      return { ...view, parts: [...view.parts, toResultPart(event)] };
    case 'draft_reset':
      return draftReset(view, event.attempt);
    case 'verification':
      return { ...view, verification: event.report };
    default:
      // Everything else says something about the generation rather than about
      // what it has written: which model, what it cost, that the connection
      // should be made again, that it is over. The hook acts on those; the view
      // has nothing to draw for them.
      return view;
  }
}

/**
 * The draft is thrown away and written again. What was released had already
 * been checked, so discarding it is safe — but the queries behind it are not
 * part of the draft, and keeping the cards is what shows the person that the
 * assistant is still working with the same data rather than starting over.
 */
function draftReset(view: StreamingView, attempt: number): StreamingView {
  return {
    ...EMPTY_VIEW,
    parts: view.parts.filter((part) => part.kind !== 'text'),
    recheckAttempt: attempt,
  };
}

/**
 * Deltas join the text part they belong to rather than becoming parts of their
 * own — a paragraph arriving in forty pieces is one paragraph, and forty of
 * them would be forty blocks with a gap between each.
 */
function withText(parts: readonly MessagePart[], delta: string): readonly MessagePart[] {
  const last = parts.at(-1);
  if (last?.kind !== 'text') return [...parts, { kind: 'text', text: delta }];

  return [...parts.slice(0, -1), { kind: 'text', text: last.text + delta }];
}

function toResultPart(event: Extract<StreamEvent, { type: 'tool_result' }>): MessagePart {
  return {
    kind: 'tool_result',
    toolCallId: event.toolCallId,
    rowCount: event.rowCount,
    preview: event.preview,
    elapsedMs: event.elapsedMs,
    error: event.error,
  };
}
