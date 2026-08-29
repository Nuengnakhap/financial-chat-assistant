// Violates tests-live-in-tests-folder. Imports a fixture rather than vitest so
// the case does not depend on anything being installed.
import { a } from './cycle-a';

export const covered = a;
