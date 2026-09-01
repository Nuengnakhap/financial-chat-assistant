import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Menu } from '@/components/Menu';

const item = (label = 'Delete', onSelect = () => undefined) => ({ label, onSelect });

describe('a menu behind one button', () => {
  it('is closed again by the button that opened it', async () => {
    // The press that closes it also reaches the dismissal, so a handler reading
    // only the current state would see "closed" and open it straight back up.
    render(<Menu label="Actions" items={[item()]} />);
    const trigger = screen.getByRole('button', { name: 'Actions' });

    await userEvent.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeNull();
    await userEvent.click(trigger);

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('is never two menus at once', async () => {
    // Which is why the press is not swallowed: it is what closes the other one.
    render(
      <>
        <Menu label="First" items={[item()]} />
        <Menu label="Second" items={[item()]} />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'First' }));
    await userEvent.click(screen.getByRole('button', { name: 'Second' }));

    expect(screen.queryAllByRole('menu')).toHaveLength(1);
  });

  it('opens onto its first item, so a keyboard has somewhere to land', async () => {
    render(<Menu label="Actions" items={[item('Rename'), item('Delete')]} />);

    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
  });

  it('walks the items with the arrow keys, and wraps', async () => {
    render(<Menu label="Actions" items={[item('Rename'), item('Delete')]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));

    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();

    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
  });

  it('closes when focus leaves it, rather than staying open behind the keyboard', async () => {
    render(
      <>
        <Menu label="Actions" items={[item()]} />
        <button type="button">Elsewhere</button>
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));

    await userEvent.tab();

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('runs the item that was chosen, and closes', async () => {
    const chosen = vi.fn();
    render(<Menu label="Actions" items={[item('Delete', chosen)]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));

    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(chosen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
