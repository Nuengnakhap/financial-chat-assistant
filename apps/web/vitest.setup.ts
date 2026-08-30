import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom is shared by every test in a file. Without this, a component from the
// previous test is still mounted and `getByRole` finds two of everything.
afterEach(cleanup);
