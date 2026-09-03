import { useEffect, useState } from 'react';

/**
 * How an answer arrives on screen, as opposed to how it arrives on the wire.
 *
 * The two are not the same, and the difference is the claim gate. Prose is
 * released a few characters at a time, but a table and a fenced block are held
 * **whole** — a number in a leading cell is only a rank once the row count is
 * known, and a fence means whatever its closing line says. Measured on
 * "จัดอันดับบริษัทตามรายได้ปี 2024": two silences of 13.8s and 12.0s, then
 * bursts of 1,529 and 2,154 characters in a single frame each.
 *
 * Nothing about that is fixable on the server without giving up the guarantee.
 * What is fixable is the two things it does to a reader: a screen that looks
 * frozen, and text that appears in a blink instead of arriving. So this reports
 * a silence, and spreads a burst over a few frames. It changes when something
 * is drawn and never what.
 */

/** Any burst is spread over about this long, whatever its size. */
const REVEAL_MS = 400;

/** A frame, roughly. */
const FRAME_MS = 16;

/** So an ordinary delta lands in the first tick and only a burst is spread. */
const LEAST_STEP = 120;

/** Longer than a pause between deltas, shorter than a person's patience. */
const QUIET_MS = 1_200;

interface Revealed {
  /** The text this position refers to; a new text starts the reveal again. */
  readonly text: string;
  readonly at: number;
}

export interface LiveText {
  /** What to draw now: the whole text, or as much of a burst as has arrived. */
  readonly shown: string;
  /** True while nothing has arrived for a while and everything sent is drawn. */
  readonly waiting: boolean;
}

export function useLiveText(text: string, live: boolean): LiveText {
  const [revealed, setRevealed] = useState<Revealed>({ text, at: text.length });
  // Which text the silence is about, so a new delta ends it without a second
  // state update: `waitingFor === text` is only true if nothing has arrived.
  const [waitingFor, setWaitingFor] = useState<string | null>(null);

  const at = revealed.text === text ? revealed.at : resumeAt(revealed, text);
  const complete = at >= text.length;

  useEffect(() => {
    if (!live || complete) return undefined;

    const timer = setInterval(() => {
      setRevealed((previous) => advance(previous, text));
    }, FRAME_MS);

    return () => {
      clearInterval(timer);
    };
  }, [text, live, complete]);

  useEffect(() => {
    if (!live) return undefined;

    const quiet = setTimeout(() => {
      setWaitingFor(text);
    }, QUIET_MS);

    return () => {
      clearTimeout(quiet);
    };
  }, [text, live]);

  return {
    shown: live ? text.slice(0, at) : text,
    waiting: live && complete && waitingFor === text,
  };
}

/**
 * Where a reveal picks up when the text changes: after what is already drawn
 * when this is an append, and from nothing when it is not — a draft the gate
 * threw away is rewritten from the start rather than grown.
 */
function resumeAt(revealed: Revealed, text: string): number {
  return text.startsWith(revealed.text) ? Math.min(revealed.at, text.length) : 0;
}

/** One frame of the reveal: bigger bursts move faster rather than taking longer. */
function advance(previous: Revealed, text: string): Revealed {
  const from = previous.text === text ? previous.at : resumeAt(previous, text);
  const remaining = text.length - from;
  if (remaining <= 0) return { text, at: text.length };

  const step = Math.max(LEAST_STEP, Math.ceil(remaining / (REVEAL_MS / FRAME_MS)));

  return { text, at: Math.min(text.length, from + step) };
}
