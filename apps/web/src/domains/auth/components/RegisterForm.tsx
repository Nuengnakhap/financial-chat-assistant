import { registerBody } from '@fca/contracts';
import { useState } from 'react';

import { useRetryCountdown } from '../hooks/useRetryCountdown';
import { useValidatedSubmit } from '../hooks/useValidatedSubmit';

import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { HINT } from '@/config/form';
import { useRegister } from '@/domains/auth/api/session';
import { messageFor } from '@/lib/api/errors';

const EMPTY = { displayName: '', email: '', password: '' };

export function RegisterForm() {
  const register = useRegister();
  const [values, setValues] = useState(EMPTY);
  const { rejected, submit } = useValidatedSubmit(registerBody, register.mutate);
  const waitSeconds = useRetryCountdown(register.error);
  const blocked = register.isPending || waitSeconds > 0;

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
      {field('displayName', 'Name', { autoComplete: 'name' })}
      {field('email', 'Email', { autoComplete: 'email', type: 'email' })}
      {field('password', 'Password', { autoComplete: 'new-password', type: 'password' })}
      {register.isError && waitSeconds === 0 && (
        <Alert tone="negative">{messageFor(register.error)}</Alert>
      )}
      <Button type="submit" variant="primary" disabled={blocked}>
        {waitSeconds > 0 ? `Try again in ${String(waitSeconds)}s` : 'Create account'}
      </Button>
    </form>
  );
}
