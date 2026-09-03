import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/Button';

/**
 * Where a question goes.
 *
 * It grows with what is typed and stops at six lines — past that the answer
 * above it is more worth the screen than the question below.
 *
 * It stays enabled while an answer is being written and refuses the send
 * instead, so the caret never jumps away from somebody mid-sentence.
 */

/** What the contract will accept, checked here so a refusal is not a round trip. */
const MAX_LENGTH = 4_000;
const MAX_ROWS = 6;
/** jsdom reports no line height at all, and a test still has to render something. */
const FALLBACK_LINE_PX = 24;

export interface ComposerProps {
  readonly busy: boolean;
  /**
   * The window is spent. Said here rather than left to the server, because the
   * refusal would arrive after the question was typed and sent — and the banner
   * above already says why.
   *
   * It refuses the send and leaves the box alone, for the same reason `busy`
   * does: a window can run out while somebody is halfway through typing the
   * next question, and disabling the box then takes the caret away mid-sentence
   * and their words with it.
   */
  readonly spent?: boolean;
  readonly onSend: (content: string) => void;
  /** Absent when there is nothing being written to stop. */
  readonly onStop?: (() => void) | undefined;
}

export function Composer({ busy, spent = false, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState('');
  const box = useGrowsWithText(text);
  const ready = text.trim() !== '' && !busy && !spent;

  const send = (): void => {
    if (!ready) return;

    onSend(text.trim());
    setText('');
  };

  return (
    <div className="mx-auto w-full max-w-room pt-8">
      {/* The rule runs the width of the room and the fields sit inside its
          gutters — the same gutters the transcript's scrollbar comes down. A
          rule that stopped short of the scrollbar left it hanging past the end
          of the line, which is what it looked like: a bar laid over the edge of
          the composer rather than the edge of the conversation. */}
      <div className="flex items-end gap-3 border-t border-line-strong px-6 pt-3">
        <Box box={box} text={text} spent={spent} onChange={setText} keys={keys({ send, onStop })} />
        {onStop === undefined ? (
          <Button variant="primary" size="sm" disabled={!ready} onClick={send}>
            Send
          </Button>
        ) : (
          <Button size="sm" onClick={onStop}>
            Stop
          </Button>
        )}
      </div>
      <Assurance />
    </div>
  );
}

interface BoxProps {
  readonly box: React.RefObject<HTMLTextAreaElement | null>;
  readonly text: string;
  readonly spent: boolean;
  readonly onChange: (text: string) => void;
  readonly keys: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

/** Split out for length alone: the rules above it are what this file is about. */
function Box({ box, text, spent, onChange, keys: onKeyDown }: BoxProps) {
  return (
    <textarea
      ref={box}
      rows={1}
      value={text}
      maxLength={MAX_LENGTH}
      aria-label="Ask a question"
      readOnly={spent}
      placeholder={
        spent ? 'Asking is paused until the limit resets' : 'Ask about revenue or net income'
      }
      onChange={(event) => {
        onChange(event.target.value);
      }}
      onKeyDown={onKeyDown}
      className="min-w-0 flex-1 resize-none bg-surface text-body text-text placeholder:text-muted"
    />
  );
}

interface Keys {
  readonly send: () => void;
  readonly onStop: (() => void) | undefined;
}

/**
 * Enter sends and Shift+Enter is a new line, because this is a question box
 * rather than a document; Escape stops an answer being written, which is the one
 * keystroke worth having when a long one is going the wrong way.
 */
function keys({ send, onStop }: Keys) {
  return (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape' && onStop !== undefined) {
      event.preventDefault();
      onStop();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey) return;

    event.preventDefault();
    send();
  };
}

function Assurance() {
  return (
    <p className="mt-3 font-mono text-micro tracking-wide text-muted uppercase">
      Every figure is verified against the query result
    </p>
  );
}

/**
 * Measured rather than counted: a line that wrapped is a line, and counting
 * newlines would leave a wrapped paragraph in a one-line box. Reset to nothing
 * first, or the box can grow but never shrink.
 */
function useGrowsWithText(text: string): React.RefObject<HTMLTextAreaElement | null> {
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = box.current;
    if (element === null) return;

    // Reset first, or the box can grow but never shrink.
    element.style.height = 'auto';
    const line = Number.parseFloat(getComputedStyle(element).lineHeight) || FALLBACK_LINE_PX;
    element.style.height = `${String(Math.min(element.scrollHeight, line * MAX_ROWS))}px`;
  }, [text]);

  return box;
}
