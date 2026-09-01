import { useEffect, useRef, useState } from 'react';

import { Button } from './Button';

import { cx } from '@/utils/cx';

export interface MenuItem {
  readonly label: string;
  readonly onSelect: () => void;
  /** `negative` for something that destroys; the colour is the only warning a list can give. */
  readonly tone?: 'negative';
}

/** Where the list opens, in viewport coordinates. `null` while it is closed. */
interface At {
  readonly top: number;
  readonly left: number;
}

/** A hair under the trigger, so the two read as one thing. */
const GAP_PX = 4;

export interface MenuProps {
  /** The accessible name of the trigger — what the menu is for, not what it looks like. */
  readonly label: string;
  readonly items: readonly MenuItem[];
  /** Applied to the trigger: a rail row reveals it on hover, a toolbar would not. */
  readonly className?: string;
}

/**
 * A list of actions behind one button. A list rather than a single action even
 * where there is only one, because the second one arrives by adding a line to an
 * array rather than by rewriting the row that held it.
 *
 * Positioned in viewport coordinates on purpose: the rail it opens from scrolls,
 * and an absolutely positioned list would be clipped by that overflow at exactly
 * the rows nearest the edge.
 */
export function Menu({ label, items, className }: MenuProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<At | null>(null);
  /**
   * Whether this menu was open when the press began. By the time the click
   * arrives the dismissal below has already closed it, so a handler that only
   * looked at the current state would read "closed" and open it straight back
   * up — the trigger would open the menu and never close it.
   *
   * Recorded rather than stopping the press from reaching the dismissal at all,
   * because that press is also what closes every *other* menu: swallow it and
   * two rows are open at once.
   */
  const wasOpen = useRef(false);

  const close = (): void => {
    setAt(null);
  };
  useDismiss(at !== null, () => {
    close();
    trigger.current?.focus();
  });

  return (
    <>
      <Button
        ref={trigger}
        size="sm"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-label={label}
        className={cx('shrink-0', className)}
        onPointerDown={() => {
          wasOpen.current = at !== null;
        }}
        onClick={() => {
          setAt(wasOpen.current ? null : below(trigger.current));
          // Reset, so a press with the keyboard — which sends no pointer event
          // — is never answered with what the mouse did last.
          wasOpen.current = false;
        }}
      >
        <Ellipsis />
      </Button>
      {at !== null && <List at={at} label={label} items={items} onChosen={close} />}
    </>
  );
}

interface ListProps {
  readonly at: At;
  readonly label: string;
  readonly items: readonly MenuItem[];
  readonly onChosen: () => void;
}

function List({ at, label, items, onChosen }: ListProps) {
  const list = useRef<HTMLDivElement>(null);

  // Opening with the keyboard has to land somewhere, and the first item is it.
  useEffect(() => {
    itemsOf(list.current)[0]?.focus();
  }, []);

  return (
    <div
      ref={list}
      role="menu"
      aria-label={label}
      // Fixed rather than absolute, so the position has to be measured. This is
      // the computed value the token rule allows.
      // eslint-disable-next-line local-tokens/no-off-token-styles
      style={{ top: at.top, left: at.left }}
      className="fixed z-10 flex min-w-rail flex-col rounded-lg border border-line bg-surface p-1 shadow-overlay"
      onPointerDown={(event) => {
        // Without this the dismissal closes the menu before the item inside it
        // has had its click.
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        move(event, list.current);
      }}
      onBlur={(event) => {
        // Focus left the menu entirely — Tab, Shift+Tab, or a click somewhere
        // else. A menu that stays open once nothing in it is focused is a menu
        // the keyboard has walked away from and left on the screen.
        if (!event.currentTarget.contains(event.relatedTarget)) onChosen();
      }}
    >
      {items.map((item) => (
        <Item key={item.label} item={item} onChosen={onChosen} />
      ))}
    </div>
  );
}

function Item({ item, onChosen }: { readonly item: MenuItem; readonly onChosen: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cx('rounded-md px-3 py-2 text-left text-body-sm hover:bg-raised', toneOf(item))}
      onClick={() => {
        onChosen();
        item.onSelect();
      }}
    >
      {item.label}
    </button>
  );
}

/** Read outside `cx` so the tone's own name is never mistaken for a class. */
function toneOf(item: MenuItem): string {
  return item.tone === 'negative' ? 'text-negative' : 'text-text';
}

function below(button: HTMLButtonElement | null): At | null {
  if (button === null) return null;
  const box = button.getBoundingClientRect();

  return { top: box.bottom + GAP_PX, left: box.left };
}

function itemsOf(list: HTMLDivElement | null): readonly HTMLElement[] {
  return list === null ? [] : [...list.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

/**
 * Arrow keys walk the list and wrap at both ends, which is what a menu is
 * expected to do once it has more than one thing in it — and what stops the
 * second item, whenever it arrives, from being reachable only with a mouse.
 */
function move(event: React.KeyboardEvent<HTMLDivElement>, list: HTMLDivElement | null): void {
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
  if (step === 0) return;

  event.preventDefault();
  const all = itemsOf(list);
  if (all.length === 0) return;

  const here = all.findIndex((item) => item === document.activeElement);
  all[(here + step + all.length) % all.length]?.focus();
}

/**
 * Escape, a click elsewhere, a scroll, or a resize. The scroll is not fussiness:
 * a fixed list anchored to a moving row has to close rather than drift away from
 * what it belongs to.
 */
function useDismiss(open: boolean, onDismiss: () => void): void {
  const dismiss = useRef(onDismiss);

  useEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!open) return undefined;

    const away = (): void => {
      dismiss.current();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss.current();
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', away);
    // Capture, because a scroll inside a scrollable region does not reach the window.
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [open]);
}

/** Three dots, drawn rather than typed: a glyph would take the body font's own weight. */
function Ellipsis() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="size-4 fill-current">
      <circle cx="4" cy="10" r="1.5" />
      <circle cx="10" cy="10" r="1.5" />
      <circle cx="16" cy="10" r="1.5" />
    </svg>
  );
}
