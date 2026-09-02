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
  readonly onSend: (content: string) => void;
  /** Absent when there is nothing being written to stop. */
  readonly onStop?: (() => void) | undefined;
}

export function Composer({ busy, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState('');
  const box = useGrowsWithText(text);
  const ready = text.trim() !== '' && !busy;

  const send = (): void => {
    if (!ready) return;

    onSend(text.trim());
    setText('');
  };

  return (
    <div className="w-full max-w-measure pt-8">
      <div className="flex items-end gap-3 border-t border-line-strong pt-3">
        <textarea
          ref={box}
          rows={1}
          value={text}
          maxLength={MAX_LENGTH}
          aria-label="Ask a question"
          placeholder="Ask about revenue or net income"
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={keys({ send, onStop })}
          className="min-w-0 flex-1 resize-none bg-surface text-body text-text placeholder:text-muted"
        />
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
