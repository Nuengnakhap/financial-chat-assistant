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
  // The PostgreSQL parser. `packages/grounding` reasons about query results and
  // must never reason about SQL: parsing it is a decision about what may run,
  // and that belongs to the one adapter that owns the policy.
  'pgsql-parser',
  'pgsql-deparser',
  'libpg-query',
];

const TEST_CODE = '[.](spec|test)[.]tsx?$|(^|/)__tests__/';

/**
 * apps/web is grouped by business domain rather than by kind of file. A domain
 * owns its api, hooks, components and helpers, and exposes one index; screens
 * are composed in pages and routes. The rules below say that in the only place
 * a rule survives, which is a config that fails the build.
 */
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
    {
      name: 'web-domain-public-api',
      severity: 'error',
      comment:
        'A domain is reached through its index and nothing else. Anything under api/, hooks/, ' +
        'components/ or utils/ is internal, and a deep import makes renaming one of those files ' +
        "another domain's problem.",
      from: { path: '^apps/web/src/domains/([^/]+)/' },
      to: {
        path: '^apps/web/src/domains/(?!$1/)[^/]+/',
        pathNot: '^apps/web/src/domains/[^/]+/index[.]ts$',
      },
    },
    {
      name: 'web-domain-public-api-from-outside',
      severity: 'error',
      comment: 'The same rule for everything that is not itself a domain.',
      from: { path: '^apps/web/src/', pathNot: '^apps/web/src/domains/' },
      to: {
        path: '^apps/web/src/domains/[^/]+/',
        pathNot: '^apps/web/src/domains/[^/]+/index[.]ts$',
      },
    },
    {
      name: 'web-dumb-components',
      severity: 'error',
      comment:
        'src/components holds components that take props and nothing else. One that fetches or ' +
        'reads a cache cannot be rendered in isolation, and a shared component that cannot be ' +
        'rendered in isolation is not shared.',
      from: { path: '^apps/web/src/components/' },
      to: {
        path:
          '^apps/web/src/(domains|lib/api)/|' +
          asModulePattern(['@tanstack/react-query', 'react-router']),
      },
    },
    {
      name: 'web-composition-flows-one-way',
      severity: 'error',
      comment:
        'Domains, layouts and shared code know nothing about the screens that use them. ' +
        'Composition happens in pages and routes, which is what keeps a domain reusable.',
      from: { path: '^apps/web/src/(domains|layouts|components|lib|utils|config)/' },
      to: { path: '^apps/web/src/(pages|routes|app)/' },
    },
    {
      name: 'web-requests-live-in-the-api-layer',
      severity: 'error',
      comment:
        'A component that fetches cannot be tested without a network and cannot be cached. ' +
        "Requests are made in lib/api or in a domain's api segment; everything else reads the " +
        'result through a query. Listening for the session to end is not a request and lives in ' +
        'lib/api/session-expiry, which anything may import.',
      from: {
        path: '^apps/web/src/',
        pathNot: '^apps/web/src/(lib/api/|domains/[^/]+/api/)',
      },
      to: { path: '^apps/web/src/lib/api/(client|http)' },
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
          '^evals/[^/]+[.]eval[.]ts$', // the eval runner, invoked by vitest
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
    // Carries the web client's `@/` mapping. Without it the rules above see an
    // unresolved specifier and stop applying — a boundary rule reporting success
    // because it found nothing to judge.
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
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
