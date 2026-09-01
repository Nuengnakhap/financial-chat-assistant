import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Modal } from '@/components/Modal';

describe('a modal', () => {
  it('shows nothing until it is opened', () => {
    render(
      <Modal open={false} title="Delete this?" onClose={() => undefined}>
        <p>Its messages go with it.</p>
      </Modal>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is named by the heading a reader sees, rather than by a second copy of it', () => {
    render(
      <Modal open title="Delete this?" onClose={() => undefined}>
        <p>Its messages go with it.</p>
      </Modal>,
    );

    expect(screen.getByRole('dialog', { name: 'Delete this?' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Delete this?' })).toBeInTheDocument();
  });

  it('names each of two on one screen after its own heading', () => {
    // A fixed id would have both pointing at the first one's heading, and this
    // is a primitive: the second use of it is somebody else's screen.
    render(
      <>
        <Modal open title="First question" onClose={() => undefined}>
          <p>one</p>
        </Modal>
        <Modal open title="Second question" onClose={() => undefined}>
          <p>two</p>
        </Modal>
      </>,
    );

    expect(screen.getByRole('dialog', { name: 'First question' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Second question' })).toBeInTheDocument();
  });

  it('reports a close the caller did not ask for, so the state that opened it stays true', async () => {
    // Escape is the browser's to handle, and it closes the dialog whether or
    // not anything is listening. What must not happen is the dialog shutting
    // while the state that opened it still says it is open.
    const onClose = vi.fn();
    render(
      <Modal open title="Delete this?" onClose={onClose}>
        <p>Its messages go with it.</p>
      </Modal>,
    );

    screen.getByRole('dialog').dispatchEvent(new Event('close'));
    await Promise.resolve();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets what it was given be acted on', async () => {
    const confirm = vi.fn();
    render(
      <Modal open title="Delete this?" onClose={() => undefined}>
        <button type="button" onClick={confirm}>
          Delete
        </button>
      </Modal>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
