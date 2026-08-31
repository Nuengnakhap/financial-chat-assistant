// Violates web-domain-public-api: reaching past another domain's index instead
// of importing what it chose to expose.
import { useSession } from '../auth/hooks/useSession';

export const Invoice = () => <div>{useSession()}</div>;
