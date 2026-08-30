import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Alert } from '../Alert';
import { Button } from '../Button';
import { Card } from '../Card';
import { cx } from '../cx';
import { Field } from '../Field';
import { Skeleton } from '../Skeleton';

describe('Button', () => {
  it('does not submit the form it happens to sit in', async () => {
    // The HTML default for a button inside a form is submit. Every "the page
    // reloaded when I clicked cancel" bug is this default.
    const submit = vi.fn();
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Button>Cancel</Button>
      </form>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(submit).not.toHaveBeenCalled();
  });

  it('still submits when a caller asks for it', async () => {
    const submit = vi.fn();
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Button type="submit">Send</Button>
      </form>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('paints the primary variant with ink, the only near-black fill', () => {
    render(<Button variant="primary">Sign in</Button>);

    // Not the accent: the one saturated hue in this interface means "verified",
    // and a button is not a claim about data. See tokens.css.
    const button = screen.getByRole('button');
    expect(button).toHaveClass('bg-ink');
    expect(button).toHaveClass('text-on-ink');
  });
});

describe('Field', () => {
  it('ties the label to the input without the caller passing an id', async () => {
    render(<Field label="Email" />);

    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');

    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com');
  });

  it('announces an error and points the input at it', () => {
    render(<Field label="Email" error="That address is not valid" />);

    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('That address is not valid');
  });

  it('says nothing about validity when there is no error', () => {
    render(<Field label="Email" />);

    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
  });
});

describe('Alert', () => {
  it('interrupts only for a failure', () => {
    const { unmount } = render(<Alert tone="negative">Could not save</Alert>);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save');
    unmount();

    render(<Alert tone="warning">The API is not running</Alert>);
    expect(screen.getByRole('status')).toHaveTextContent('The API is not running');
  });

  it('shows a title above the body when it has one', () => {
    render(
      <Alert tone="positive" title="Saved">
        Your changes are stored.
      </Alert>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    expect(screen.getByRole('status')).toHaveTextContent('Your changes are stored.');
  });
});

describe('Card and Skeleton', () => {
  it('renders card content', () => {
    render(<Card>Balance</Card>);

    expect(screen.getByText('Balance')).toBeInTheDocument();
  });

  it('hides a skeleton from assistive technology', () => {
    const { container } = render(<Skeleton className="h-4 w-12" />);

    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('cx', () => {
  it('drops everything that is not a usable class name', () => {
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b');
  });
});
