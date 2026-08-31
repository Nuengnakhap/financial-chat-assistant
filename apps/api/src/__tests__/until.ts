/** How long to keep asking before calling it a failure rather than a delay. */
const ATTEMPTS = 150;
const INTERVAL_MS = 100;

/**
 * Waits for something a broker, a worker or a background loop will make true,
 * rather than for a fixed number of milliseconds and a hope. A sleep long
 * enough to be reliable is a slow suite, and one short enough to be quick is a
 * test that fails on a loaded machine for no reason anybody can see.
 *
 * The label is what the failure says, so it names what was expected to happen
 * rather than reporting that a timer went off.
 */
export async function until(what: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling is the point.
    if (await what()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }

  throw new Error(`timed out waiting for ${label}`);
}
