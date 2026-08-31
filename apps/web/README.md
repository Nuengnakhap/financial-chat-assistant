# `@fca/web`

Vite + React 19 on TypeScript. The browser client; it knows the API only through
the schemas in `@fca/contracts`.

## Layout

```text
index.html                   the entry Vite serves and builds
public/                      served as-is, no bundling
src/
├── main.tsx                 mounts the tree; the one file that touches the document
├── app/                     providers and the boundary the whole tree sits in
├── routes/                  the router and the guards that decide who sees what
├── pages/                   one file per route: a layout plus a domain, nothing else
├── layouts/                 the frame a page sits in
├── components/              presentational primitives; no domain reaches them
├── domains/                 one folder per capability
│   └── auth/                api/ components/ hooks/ utils/, and an index.ts
├── lib/                     api client, http, theme — knows no domain
├── config/                  values with no logic in them
└── utils/                   pure helpers
```

The structure is **domain-driven**, and three rules hold it together:

**Strict encapsulation.** A domain is entered through its `index.ts` and nowhere
else. `@/domains/auth` is the whole surface; `@/domains/auth/api/session` is a
reach past it, and reaching past it is how an internal file becomes something
nobody can rename.

**No cross-domain logic.** One domain never imports another's internals. What
two of them need is not shared between them — it moves down into `lib/`,
`components/` or `utils/`, where it belongs to neither.

**Dumb and smart are separated.** Everything in `components/` is presentational:
it takes props and renders. Anything that fetches, mutates or reads session
state lives in a domain, which is why `components/` can be read without knowing
what this product does.

None of the three is a convention. All of them live in `.dependency-cruiser.cjs`
as `web-domain-public-api`, `web-domain-public-api-from-outside`,
`web-dumb-components`, `web-composition-flows-one-way` and
`web-requests-live-in-the-api-layer`, they fail `pnpm lint`, and
`tools/architecture/fixtures/apps/web/` breaks each one on purpose so a config
change that stops catching them fails a test instead.

Only the folders with something in them exist. An empty directory is a structure
nobody has justified yet.

## Colour, type and theme

Tokens live in `src/styles/tokens.css` as OKLCH, in a Tailwind v4 `@theme`
block. Every scale it owns — colour, spacing, radius, type, weight, tracking,
measure, depth — is closed with `*: initial`, which deletes Tailwind's own:
`bg-blue-500`, `p-5` and `max-w-3xl` compile to nothing, so "one accent", "one
spacing rhythm" and "one readable line length" are rules rather than
suggestions.

**The direction is editorial.** Structure comes from hairlines, white space and
type — not from cards, fills and shadows. The depth scale is declared and left
empty, so there is no `shadow-*` utility at all and a component cannot reach for
one: a surface is set apart by its rule and by the space around it. Radii are
near-square for the same reason. An input is a label above a line rather than a
box, and an alert is a rule and a sentence rather than a tinted panel — a failed
sign-in should not be the loudest thing on the page it is about.

Type carries the hierarchy instead. Seven sizes, each with the leading it wants,
and two things the scale exists to make automatic: a display heading at `book`
(450) with tight tracking, and the small mono, upper-cased, wide-tracked label
this direction uses in place of a bold sans one.

**Light is the default and dark is an override.** The light values sit in
`:root`, so a first-time visitor gets the right colours from the first byte of
CSS with no JavaScript involved. The only thing the inline script in
`index.html` does is restore a stored choice of dark before the first paint —
without it, everyone who picked dark would see a white flash on every load. The
choice is two values, never three: a "system" option is a state nobody can read
off the screen, and it changes under you when the operating system decides it is
evening.

**Contrast is a test, not an intention.** `src/styles/__tests__/contrast.spec.ts`
reads the shipped `tokens.css`, converts each OKLCH value to a relative
luminance, and asserts every pair this interface actually renders: 4.5:1 for
text, 3:1 for the things WCAG treats as non-text, in both themes. It proves its
own arithmetic first — white against black has to come out at 21:1 — because a
checker that is quietly wrong is worse than none.

That test is why some tokens exist. `--color-line` rules off a region and is
deliberately quiet; `--color-line-strong` is the edge of a control, and WCAG
1.4.11 asks 3:1 of a boundary that identifies one. Under this direction an input
is nothing but that boundary, so the distinction stopped being academic.

**One class cannot leave the scales.** `local/no-off-token-styles` bans
arbitrary Tailwind values (`p-[13px]`) and inline `style`, and
`src/styles/__tests__/tokens.spec.ts` compiles every `className` in the source —
literals, expressions such as `className={busy ? 'a' : 'b'}`, and quoted
arguments to `cx` alike — and fails with a file and a line when one produces no
CSS, because an off-scale class is silent otherwise and is found by looking at
the screen.

Colour says one thing here. The interface is paper and ink: a primary button is
`--color-ink`, near-black on light and near-white on dark, and so is the focus
ring, because neither is a claim about data. The single saturated hue is
`--color-verified`, reserved for the figure treatment — mono numerals on
`--color-verified-soft`, and the badge that counts them — so that a link, a
button and a heading never borrow the colour that means "this number was checked
against the query result".

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
cookie this code does read is `fca_csrf`, and only to echo it back in a header,
on every request rather than only on mutations: the server checks whenever a
session cookie is present rather than for a list of routes, so "only on
mutations" would be a rule with an exception hiding in it.

**One refresh at a time.** A 401 sends `apiFetch` through a refresh and exactly
one retry, and every request that got a 401 while that refresh was running waits
for the same one. This is not an optimisation. The refresh token rotates on each
use, so two concurrent refreshes present the same token twice, and the server
reads a token presented twice as stolen and revokes the whole lineage — racing
here signs the person out. React's StrictMode makes it a certainty rather than a
race: it mounts twice, so the very first page load issues two requests.

A second 401 after a successful refresh is not an expired token, so there is no
second attempt; the failure surfaces and a refusal to refresh at all ends the
session through `onSessionExpired`.

## Talking to the API

Nothing calls `fetch` with a path. `lib/api/client.ts` builds one object from
the schemas in `@fca/contracts`, so the path, the verb, the body and the answer
are all typed from the same definition the server validates against:

```ts
const { user } = await api.auth.me();
await api.auth.revokeSession({ params: { id } });
```

A wrong body, a missing path parameter, an endpoint that does not exist, or a
field read off the answer that the schema does not have are all compile errors —
`lib/api/__tests__/client.spec.ts` keeps four of them as `@ts-expect-error`, which fail
the build if they ever stop being errors.

Answers are parsed with the contract rather than trusted. Unknown fields are
stripped instead of rejected, so a server that adds one stays compatible with a
client that has not shipped yet.

A failure arrives as `ApiError` carrying the server's own wording, its code and
its status — the API writes messages for people, so repeating that job here
would only produce a second, worse copy. `NetworkError` is separate because "no
answer" and "a refusal" are different things to say.

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
