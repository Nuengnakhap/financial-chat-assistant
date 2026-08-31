import { CSRF_HEADER, SESSION_COOKIE } from '@fca/contracts';

/**
 * Keeps whatever the server last set, the way a browser would, so an
 * integration test carries a session from one request to the next without
 * knowing how it is stored.
 *
 * The names come from `@fca/contracts` for the reason they live there: the
 * server sets these and the browser client reads one of them, and a second
 * literal is how the two drift into every mutation answering 403. That applies
 * to a test standing in for a browser as much as to the browser.
 */
export class CookieJar {
  private readonly values = new Map<string, string>();

  absorb(header: string | string[] | undefined): void {
    const all = header === undefined ? [] : Array.isArray(header) ? header : [header];
    for (const cookie of all) {
      const [pair] = cookie.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (pair === undefined || separator < 0) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      // An empty value is how a server says "forget this one".
      if (value === '') this.values.delete(name);
      else this.values.set(name, value);
    }
  }

  get cookies(): Record<string, string> {
    return Object.fromEntries(this.values);
  }

  /** The one cookie a page may read, echoed into the header that proves it did. */
  get csrf(): Record<string, string> {
    const token = this.values.get(SESSION_COOKIE.csrf);

    return token === undefined ? {} : { [CSRF_HEADER]: token };
  }
}
