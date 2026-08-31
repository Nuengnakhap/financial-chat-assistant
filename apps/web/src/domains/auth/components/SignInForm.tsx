import { loginBody } from '@fca/contracts';
import { useState } from 'react';

import { useRetryCountdown } from '../hooks/useRetryCountdown';
import { useValidatedSubmit } from '../hooks/useValidatedSubmit';

import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { HINT } from '@/config/form';
import { useSignIn } from '@/domains/auth/api/session';
import { messageFor } from '@/lib/api/errors';

const EMPTY = { email: '', password: '' };

export function SignInForm() {
  const signIn = useSignIn();
  const [values, setValues] = useState(EMPTY);
  const { rejected, submit } = useValidatedSubmit(loginBody, signIn.mutate);
  const waitSeconds = useRetryCountdown(signIn.error);

  const field = (name: keyof typeof EMPTY, label: string, extra: Record<string, string>) => (
    <Field
      label={label}
      value={values[name]}
      onChange={(event) => {
        setValues({ ...values, [name]: event.target.value });
      }}
      {...extra}
      {...(rejected.has(name) ? { error: HINT[name] } : {})}
    />
  );

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit(values);
      }}
    >
      {field('email', 'Email', { autoComplete: 'email', type: 'email' })}
      {field('password', 'Password', { autoComplete: 'current-password', type: 'password' })}
      {signIn.isError && waitSeconds === 0 && (
        <Alert tone="negative">{messageFor(signIn.error)}</Alert>
      )}
      <Button type="submit" variant="primary" disabled={signIn.isPending || waitSeconds > 0}>
        {waitSeconds > 0 ? `Try again in ${String(waitSeconds)}s` : 'Sign in'}
      </Button>
    </form>
  );
}
