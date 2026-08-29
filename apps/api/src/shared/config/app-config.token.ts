/**
 * In its own file so that a module needing configuration does not import the
 * composition root — which would make the graph circular the moment the
 * composition root imports that module back.
 */
export const APP_CONFIG = Symbol('AppConfig');
