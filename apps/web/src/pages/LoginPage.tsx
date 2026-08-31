import { Link } from 'react-router';

import { SignInForm } from '@/domains/auth';
import { AuthLayout } from '@/layouts/AuthLayout';

export function LoginPage() {
  return (
    <AuthLayout
      title="Sign in"
      subtitle="Ask about the revenue and income of U.S. public companies."
      footer={
        <>
          No account yet?{' '}
          <Link to="/register" className="text-text underline underline-offset-4">
            Create one
          </Link>
        </>
      }
    >
      <SignInForm />
    </AuthLayout>
  );
}
