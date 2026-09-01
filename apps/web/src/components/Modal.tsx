import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface ModalProps {
  readonly open: boolean;
  /** The accessible name, and the heading a reader sees. */
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/**
 * The one surface in this interface that floats over everything, and the one
 * place a question has to be answered before anything else can be.
 *
 * Built on `<dialog>` rather than on a div with a backdrop, because the platform
 * already does the parts that are easy to get wrong: focus is trapped inside
 * while it is open and restored to the trigger when it closes, Escape closes it,
 * and the page behind it is inert. Every hand-rolled version of that is a list
 * of the bits somebody forgot.
 */
export function Modal({ open, title, onClose, children }: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  // Generated rather than fixed: this is a primitive, and two of them on one
  // screen with the same id would have both pointing at the first one's heading.
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    // `showModal` is absent in a server render and in some test environments; a
    // modal that cannot open is better than a render that throws.
    if (element === null || typeof element.showModal !== 'function') return;

    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      // Escape fires `cancel`, and closing any other way fires `close`. Both are
      // reported the same way, so the state that opened it stays the truth.
      onCancel={onClose}
      onClose={onClose}
      className="m-auto max-w-measure rounded-lg border border-line bg-surface p-8 text-text shadow-overlay backdrop:bg-scrim"
    >
      <div className="flex flex-col gap-4">
        <h2 id={titleId} className="text-heading-sm font-book tracking-snug">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}
