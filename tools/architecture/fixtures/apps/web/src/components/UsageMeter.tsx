// Violates web-dumb-components and web-requests-live-in-the-api-layer: a shared
// component that fetches cannot be rendered on its own.
import { api } from '../lib/api/client';

export const UsageMeter = () => {
  void api.auth.me();
  return <div>usage</div>;
};
