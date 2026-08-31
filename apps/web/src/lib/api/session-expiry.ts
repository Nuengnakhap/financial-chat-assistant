type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Fires once a refresh has been refused, which is the only way a session truly
 * ends. It lives apart from the request layer so that listening for it is not
 * the same thing as being allowed to make requests — the router needs the first
 * and must not have the second.
 */
export function onSessionExpired(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function announceSessionExpired(): void {
  for (const listener of listeners) listener();
}
