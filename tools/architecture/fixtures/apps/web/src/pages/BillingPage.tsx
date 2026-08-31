// Violates web-domain-public-api-from-outside: a screen reaching past the index
// of a domain it composes.
import { useSession } from '../domains/auth/hooks/useSession';

export const BillingPage = () => <div>{useSession()}</div>;
