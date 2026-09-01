import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom is shared by every test in a file. Without this, a component from the
// previous test is still mounted and `getByRole` finds two of everything.
afterEach(cleanup);

/**
 * jsdom implements `<dialog>` as an element and not as a dialog: `showModal`
 * and `close` are simply absent, so a modal built on the platform's own
 * behaviour could never be opened in a test, and its confirmation step would be
 * covered by nothing but a browser run.
 *
 * What is filled in here is only the part a test observes — whether it is open,
 * and that closing reports itself. Focus trapping, inertness and the backdrop
 * belong to the browser, and are checked in one.
 *
 * Read as `Partial` because the DOM types promise these methods exist and this
 * environment does not have them: the check is real, and the types are what is
 * wrong about it.
 */
const dialog: Partial<HTMLDialogElement> = HTMLDialogElement.prototype;

if (dialog.showModal === undefined) {
  dialog.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
  dialog.close = function close(this: HTMLDialogElement): void {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}

/**
 * The same gap, one element up: jsdom lays nothing out, so it has no scrolling
 * to do and no `scrollIntoView` to do it with. A no-op is the honest stand-in —
 * where a conversation opens is a question about layout, and layout is what a
 * browser has.
 */
const element: Partial<Element> = Element.prototype;

element.scrollIntoView ??= function scrollIntoView(): void {
  // Nothing to scroll: jsdom has no viewport.
};
