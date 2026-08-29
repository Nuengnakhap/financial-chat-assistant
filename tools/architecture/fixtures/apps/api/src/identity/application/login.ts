// Violates no-cross-context: identity reaching into generation's internals
// instead of going through a port or a domain event.
import { startGeneration } from '../../generation/application/start';

export const login = (): string => startGeneration();
