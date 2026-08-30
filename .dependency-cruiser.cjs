/**
 * Layer boundaries erode silently: one convenient import compiles, passes tests and
 * is invisible in review. These rules fail CI instead.
 *
 * `tools/architecture/__tests__/architecture.spec.ts` runs this exact config against
 * fixtures that violate it on purpose.
 */

const FRAMEWORKS = [
  '@nestjs/.+',
  'drizzle-orm',
  'drizzle-kit',
  'pg',
  'postgres',
  'ioredis',
  'bullmq',
  'react',
  'react-dom',
  'fastify',
  '@fastify/.+',
  'openai',
];

const TEST_CODE = '[.](spec|test)[.]tsx?$|(^|/)__tests__/';

/**
 * apps/web is feature-sliced: shared → entities → features/widgets → pages → app.
 * Listed outermost first so a slice may only name the ones after it.
 */
const WEB_LAYERS = ['app', 'pages', 'widgets', 'features', 'entities', 'shared'];

/** Everything a layer sits below, as an alternation for a path pattern. */
const above = (layer) => WEB_LAYERS.slice(0, WEB_LAYERS.indexOf(layer)).join('|');

/**
 * Matches a module resolved into node_modules and one that is not installed at all —
 * otherwise the rule would only start working after someone had added the package.
 */
const asModulePattern = (names) => {
  const alternatives = names.join('|');
  return `(^|/)node_modules/(${alternatives})(/|$)|^(${alternatives})(/|$)`;
};

module.exports = {
  forbidden: [
    {
      name: 'no-framework-in-packages',
      severity: 'error',
      comment:
        'packages/* stay framework-free so the domain can be tested without a container, ' +
        'a database or a browser, and so a framework change never reaches business rules.',
      from: { path: '^packages/' },
      to: { path: asModulePattern(FRAMEWORKS) },
    },
    {
      name: 'no-app-to-app',
      severity: 'error',
      comment: 'apps/api and apps/web communicate over HTTP and shared contracts, never by import.',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'layer-domain-inward',
      severity: 'error',
      comment:
        'The domain layer knows nothing about the layers that use it. An import pointing ' +
        'outward means a business rule has been made to depend on a delivery mechanism.',
      from: { path: '^apps/api/src/([^/]+)/domain/' },
      to: { path: '^apps/api/src/[^/]+/(application|infrastructure|presentation)/' },
    },
    {
      name: 'layer-application-inward',
      severity: 'error',
      comment:
        'Use cases depend on ports, never on the adapters that implement them or on controllers.',
      from: { path: '^apps/api/src/([^/]+)/application/' },
      to: { path: '^apps/api/src/[^/]+/(infrastructure|presentation)/' },
    },
    {
      name: 'no-cross-context',
      severity: 'error',
      comment:
        'Bounded contexts talk through ports and domain events. A direct import couples their ' +
        'internals and makes either one impossible to change alone.',
      from: { path: '^apps/api/src/(?!shared/)([^/]+)/' },
      to: {
        path: '^apps/api/src/(?!shared/)([^/]+)/(application|infrastructure|presentation)/',
        pathNot: '^apps/api/src/$1/',
      },
    },
    ...WEB_LAYERS.slice(1).map((layer) => ({
      name: `web-layer-${layer}-inward`,
      severity: 'error',
      comment:
        `apps/web/src/${layer} may not import from a layer above it. Feature-sliced layers ` +
        'only mean anything while the arrows point one way; the first upward import turns ' +
        'the whole tree back into a folder listing.',
      from: { path: `^apps/web/src/${layer}/` },
      to: { path: `^apps/web/src/(${above(layer)})/` },
    })),
    {
      name: 'web-no-cross-slice',
      severity: 'error',
      comment:
        'Two slices in the same layer are siblings, not dependencies. Whatever both need ' +
        'belongs in shared; importing across makes one impossible to delete.',
      from: { path: '^apps/web/src/(entities|features|widgets|pages)/([^/]+)/' },
      to: { path: '^apps/web/src/$1/', pathNot: '^apps/web/src/$1/$2/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A cycle means the two files are really one module that has not been named yet, and it ' +
        'makes initialisation order load-bearing.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'error',
      comment: 'Nothing imports this file. Dead code that still typechecks is the worst kind.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)[.][^/]+[.](?:js|cjs|mjs|ts|json)$', // dotfiles such as .dependency-cruiser.cjs
          '[.]d[.]ts$',
          '(^|/)tsconfig[.].*json$',
          '(^|/)(package|knip)[.]json$',
          '^packages/[^/]+/src/index[.]ts$', // package entry points
          '[.]config[.](js|cjs|mjs|ts|mts|cts)$',
          '^scripts/', // operator-run entry points, invoked from package.json
          '^apps/[^/]+/src/main[.]ts$', // process entry points
          '^apps/[^/]+/worker-threads/', // loaded by filename on a thread, never imported
          '(^|/)__tests__/.*[.]cjs$', // the same, for the workers a test stands up
        ],
      },
      to: {},
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment: 'An import that cannot be resolved is a build failure waiting for the right branch.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-test-in-production-code',
      severity: 'error',
      comment: 'Production code reaching into a test tree ships the harness with it.',
      from: { pathNot: TEST_CODE },
      to: { path: TEST_CODE },
    },
    {
      name: 'tests-live-in-tests-folder',
      severity: 'error',
      comment: 'Spec files belong in a __tests__ directory beside the code they cover.',
      from: { path: '[.](spec|test)[.]tsx?$', pathNot: '(^|/)__tests__/' },
      to: {},
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    // Fixtures break these rules deliberately; only their own test cruises them.
    exclude: { path: '(^|/)(dist|coverage)/|(^|/)tools/architecture/fixtures/' },
    // Without this an `import type` is invisible and can smuggle a forbidden dependency.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['require', 'import', 'browser', 'node', 'types', 'default'],
      // Without .tsx an import between two components resolves to nothing, and a
      // rule whose `to` never matches reports success. Measured on a fixture that
      // breaks a layer rule: unresolved before adding it, caught after.
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
