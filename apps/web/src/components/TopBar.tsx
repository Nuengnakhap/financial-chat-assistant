import { ThemeToggle } from './ThemeToggle';

/**
 * The same bar on every screen, signed in or not. It exists as one component
 * rather than as markup in each layout because the two would drift, and a
 * product whose header moves four pixels between sign-in and the application is
 * a product that looks assembled.
 *
 * It takes no slot. Who is signed in, and what they can do about it, belongs to
 * the rail beside the conversation — putting a copy up here as well would give
 * the same action two homes. The theme is the exception: it applies to the
 * sign-in screen too, where there is no rail.
 */
export function TopBar() {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-line px-8">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-6 items-center justify-center rounded-sm bg-ink text-micro font-semibold text-on-ink"
        >
          F
        </span>
        <p className="font-mono text-micro font-medium tracking-wide uppercase">
          Financial Chat Assistant
        </p>
      </div>
      <ThemeToggle />
    </header>
  );
}
