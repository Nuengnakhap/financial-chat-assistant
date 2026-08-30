// Violates web-layer-shared-inward: shared reaching up into a feature. If shared
// knows what a feature is, it is not shared.
import { Composer } from '../features/composer/Composer';

export const Panel = () => <Composer />;
