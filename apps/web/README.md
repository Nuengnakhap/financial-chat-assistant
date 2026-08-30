# `@fca/web`

Vite + React 19 on TypeScript. The browser client; it knows the API only through
the schemas in `@fca/contracts`.

## Layout

```text
index.html                   the entry Vite serves and builds
public/                      served as-is, no bundling
src/
├── main.tsx                 mounts the tree; the one file that touches the document
├── app/                     bootstrap: providers, router, root error boundary
├── shared/                  knows no feature — api client, formatting, ui primitives
├── entities/                a resource: its model and how it is fetched
├── features/                something a person does with an entity
├── widgets/                 an assembled region of a page
└── pages/                   routes, which compose the above
```

Layers are **feature-sliced** and depend one way only: `app → pages → widgets →
features → entities → shared`. A slice may not import a sibling in its own
layer — whatever two of them need belongs in `shared`, and reaching sideways is
what makes either one impossible to delete later.

Neither rule is a convention. Both live in `.dependency-cruiser.cjs` and fail
`pnpm lint`, and `tools/architecture/fixtures/apps/web/` breaks each one on
purpose so a config change that stops catching them fails a test instead.

Only the folders with something in them exist. An empty directory is a structure
nobody has justified yet.

## Three rules this package exists to hold

**The API is proxied, never reached across origins.** Vite serves the page on
`:5173` and forwards `/api` and `/healthz` to `:3000`, so the browser only ever
sees one origin. Both session cookies are `SameSite=Strict` and the refresh
cookie is pinned to `/api/v1/auth`; a second origin would make those attributes
meaningless, and opening CORS to compensate would punch a hole in exactly what
they close. Outside development the two sit behind one origin anyway, so this
matches production rather than working around it.

**A token never reaches JavaScript.** `fca_access` and `fca_refresh` are
`httpOnly`, so nothing here can read them — the browser attaches them. The one
cookie this code does read is `fca_csrf`, and only to echo it back in a header.

**Effects clean up.** Every subscription, timer and request is created with an
`AbortController` and aborted on unmount. This is not hypothetical tidiness:
React's StrictMode mounts each component twice in development, so the first
request really is cancelled on every page load, and a missing cleanup shows up
as a state update on an unmounted tree rather than as an obvious bug.

## Running it

```bash
pnpm dev                         # from the repository root: API on :3000, web on :5173
pnpm --filter @fca/web dev       # the web app alone; API calls will answer 502
```

The API answering `502` is what the proxy returns when nothing is listening on
`:3000` — the page says so rather than hanging.

## Tests

`pnpm test` runs this package's specs under jsdom as the `web` project. What
they cover is component and module logic; a browser is what covers a browser,
and Playwright arrives with the first flow that spans several pages.

JSX needs no plugin in the test path: the default transform reads `jsx:
react-jsx` from the tsconfig nearest the file, the same way `apps/api` gets its
decorators. `@vitejs/plugin-react` is for the dev server and the bundle.

Coverage includes this package at the same 95% threshold as everything else.
`main.tsx` is the single exclusion: it mounts into a real document, which a unit
test cannot do without becoming a worse copy of opening the page.
