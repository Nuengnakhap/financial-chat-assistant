/**
 * The names the two sides have to agree on. They are part of the HTTP contract
 * as much as any body is: the server sets these cookies and reads that header,
 * and the browser client reads the one cookie it is allowed to and echoes it
 * back. Two literals in two packages would drift into every mutation answering
 * 403, with nothing failing to say why.
 */
export const SESSION_COOKIE = {
  /** Short-lived, `httpOnly`. Nothing in a page can read it. */
  access: 'fca_access',
  /** `httpOnly` and pinned to the auth path, so no other request can leak it. */
  refresh: 'fca_refresh',
  /** The only one JavaScript may read, and only to echo it into the header. */
  csrf: 'fca_csrf',
} as const;

/** Where the readable cookie is echoed. A cross-site page can send neither. */
export const CSRF_HEADER = 'x-csrf-token';
