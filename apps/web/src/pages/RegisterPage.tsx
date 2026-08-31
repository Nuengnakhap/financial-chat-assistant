import { Link } from 'react-router';

import { RegisterForm } from '@/domains/auth';
import { AuthLayout } from '@/layouts/AuthLayout';

export function RegisterPage() {
  return (
    <AuthLayout
      title="Create an account"
      subtitle="Ask about the revenue and income of U.S. public companies."
      footer={
        <>
          Already have one?{' '}
          <Link to="/login" className="text-text underline underline-offset-4">
            Sign in
          </Link>
        </>
      }
    >
      <RegisterForm />
    </AuthLayout>
  );
}
