// Violates web-no-cross-slice: one entity reaching into another instead of
// putting what they share in `shared`.
import { currentUser } from '../user/model';

export const owner = (): string => currentUser();
