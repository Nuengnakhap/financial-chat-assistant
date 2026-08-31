/**
 * What a rejected field is told. The rules live in `@fca/contracts` — these are
 * only the sentences, because a validator's own message is written for whoever
 * wrote the validator. `domains/auth/__tests__/SignInForm.spec.tsx`
 * checks the numbers here still match the schema, so a changed rule cannot
 * leave the wording behind.
 */
export const HINT = {
  email: 'Enter a valid email address.',
  password: 'Use at least 12 characters.',
  displayName: 'Enter the name you want to be shown.',
};
