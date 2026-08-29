// Violates no-circular, together with cycle-b.
import { b } from './cycle-b';

export const a = (): string => b();
