import type { SemanticCatalog } from '../semantic-catalog';

/**
 * Where the catalog comes from. A port because what the application needs is
 * "what does this dataset hold", and the answer to that is a query against a
 * particular server — the one thing a test of the prompt should not need.
 */
export interface CatalogSource {
  build(): Promise<SemanticCatalog>;
}

export const CATALOG_SOURCE = Symbol('CatalogSource');
