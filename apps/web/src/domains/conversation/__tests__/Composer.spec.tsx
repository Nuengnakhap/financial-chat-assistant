import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Composer } from '../components/Composer';

/**
 * The box a question goes in. What is worth testing about it is the keyboard:
 * a question box where Enter makes a new line is a question box people press
 * send on twice, and one where Shift+Enter sends is one they cannot write two
 * sentences in.
 */

const box = () => screen.getByLabelText('Ask a question');

describe('sending', () => {
  it('sends on Enter', async () => {
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);

    await userEvent.type(box(), 'What was the revenue of Apple in 2024?{Enter}');

    expect(onSend).toHaveBeenCalledWith('What was the revenue of Apple in 2024?');
  });

  it('makes a new line on Shift+Enter, and sends nothing', async () => {
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);

    await userEvent.type(box(), 'first{Shift>}{Enter}{/Shift}second');

    expect(onSend).not.toHaveBeenCalled();
    expect(box()).toHaveValue('first\nsecond');
  });

  it('empties the box, so the next question starts from nothing', async () => {
    render(<Composer busy={false} onSend={vi.fn()} />);

    await userEvent.type(box(), 'hello{Enter}');

    expect(box()).toHaveValue('');
  });

  it('sends nothing that is only whitespace', async () => {
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);

    await userEvent.type(box(), '   {Enter}');

    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('while an answer is being written', () => {
  it('takes the typing but refuses the send', async () => {
    const onSend = vi.fn();
    render(<Composer busy onSend={onSend} onStop={vi.fn()} />);

    await userEvent.type(box(), 'another question{Enter}');

    // The box stays live on purpose: disabling it would take the caret away
    // from somebody mid-sentence.
    expect(box()).toHaveValue('another question');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('offers Stop in place of Send', () => {
    render(<Composer busy onSend={vi.fn()} onStop={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('stops on Escape, which is the keystroke worth having', async () => {
    const onStop = vi.fn();
    render(<Composer busy onSend={vi.fn()} onStop={onStop} />);

    await userEvent.type(box(), '{Escape}');

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('does nothing on Escape when there is nothing to stop', async () => {
    render(<Composer busy={false} onSend={vi.fn()} />);

    await userEvent.type(box(), 'half a question{Escape}');

    expect(box()).toHaveValue('half a question');
  });
});
