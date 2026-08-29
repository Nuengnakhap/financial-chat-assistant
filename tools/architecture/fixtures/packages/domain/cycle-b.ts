import { a } from './cycle-a';

export const b = (): string => (Math.random() > 1 ? a() : 'b');
