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
│   ├── auth/                api/ components/ hooks/ utils/, and an index.ts
│   ├── conversation/        the rail, the room, the stream, and what deletes one
│   └── usage/               the meter, and the banner when a window is spent
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
almost empty: it holds one step, `--shadow-overlay`, and the two things that
genuinely float use it — a row menu and a modal, each drawn over the surface it
belongs to, where a hairline alone leaves it ambiguous which of the two is on
top. Everything else is set apart by its rule and by the space around it, which
is why the scale is closed rather than merely short. Radii are
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

A modal lays `--color-scrim` over the page, and that token is the one colour
with its alpha baked in and no dark override. `--color-ink` inverts between
themes, so a veil built from it would dim a light page and wash a dark one out;
a scrim is one decision rather than a colour and an opacity kept in step.

## The rules this package exists to hold

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

That announcement is ignored on `/login` and `/register`. A visitor who has
never signed in gets a 401 from the first `/auth/me`, a 401 from the refresh
behind it, and therefore a session-expired announcement — which, sent to a
router that redirects on it, takes somebody who clicked "Register" back to the
sign-in screen a beat after the form appears. Only a real browser shows it: in
jsdom the two requests resolve before the screen is asserted on.

**The page loads nothing it did not ship with.** `index.html` carries a
`Content-Security-Policy` meta tag with `script-src 'self'` plus the SHA-256 of
the one inline script — the theme restore, which has to run before first paint
or everyone who chose dark sees a white flash. `'unsafe-inline'` would allow
that script and equally any an injection managed to write into the page, and a
hash goes stale the moment somebody edits the script, so `theme.spec.ts`
recomputes it. `frame-ancestors` is deliberately absent: it is ignored in a meta
tag and Chromium says so in the console on every load, which is how a console
stops being read. Framing is refused by the header the API sends.

## Talking to the API

Nothing calls `fetch` with a path. `lib/api/client.ts` builds one object from
the schemas in `@fca/contracts`, so the path, the verb, the body and the answer
are all typed from the same definition the server validates against:

```ts
const { user } = await api.auth.me();
await api.auth.revokeSession({ params: { id } });
```

A paginated endpoint takes a query the same way, and a field with no value is
left out of the URL rather than sent as the word `null` — which is what the
first page's absent cursor would otherwise become, and what the server would
then try to decode. The field names come from the schema; the values are
narrowed to `string | number | null` on purpose, because `z.coerce.number()`
declares its input as `unknown`, and that would let an object be stringified
into a URL. An endpoint whose payload is entirely optional is called with no
arguments at all rather than with an empty object to satisfy a signature.

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

## The conversation surface

A list is read by keyset: the rail and a conversation's history are both
infinite queries whose page parameter is the opaque cursor the server handed
back. The rail is keyed `['conversations']` and a history `['conversations', id,
'messages']`, which is a hierarchy worth having and one accident waiting inside
it — invalidating the rail by prefix re-reads every open thread, including the
one belonging to the conversation just deleted, which the server answers 404
because it is right to. Every invalidation of the rail is therefore `exact`.

Deleting is optimistic: the row leaves the rail on confirmation, because the
server answers 202 and the conversation is gone from every read by then. A
failure puts it back. The mutation belongs to the list rather than to the row —
the row is what the deletion removes, so a callback passed to `mutate` from
inside it is never called, which is how the page showing that conversation was
once left sitting there after the conversation had gone.

A conversation opens at its end. The pages arrive newest-first and each page
reads oldest-first inside itself, so the chunks are reversed and their contents
are not; the newest message is then scrolled to, and stays followed while an
answer is written — for as long as the reader is there too. Distance from the
bottom cannot tell the two apart, because content arriving widens that distance
without anybody touching the scroll; what separates a reader who has moved from
a page that has grown is the _direction_, so only a scroll that goes up from
where the room last left it stops the following.

## Watching an answer being written

Asking answers `202` with a message id, and everything after that is a stream
the page attaches to. Attaching for the first time, opening a second tab and
coming back after a dropped connection are one code path: the client says where
it got to with `Last-Event-ID` and is given everything after it.

It is read with `fetch` and a `ReadableStream` rather than `EventSource`, for two
reasons that both decide it. `EventSource` cannot set a header, and
`Last-Event-ID` on the _first_ connection is the whole of resuming after a
refresh — the browser sends that header only on reconnections it made itself,
and a page that has just loaded has none. And it reconnects on its own schedule,
which would race the backoff the page needs to own.

The stream is read into one `useReducer` and nothing else. There is no store: the
state lives exactly as long as the page and nobody else reads it. Every
transition is total — an event this build does not expect, or one that arrives in
a phase where it makes no sense, is ignored rather than thrown, because a stream
is the one place where an older tab meets a newer server.

The query cache is not touched until the end. Invalidating mid-stream would
re-render the whole history for every delta, and the answer is not in the history
until it is finished; the question is not read back either, because the page
already has it and reading it would show the same question twice.

**One renderer draws an answer being written and an answer written last week.**
The stream builds the same `parts` a stored message has, so the two cannot
quietly stop agreeing. A `draft_reset` — the gate finding a figure with nothing
behind it — clears the text and keeps the query cards, because the data did not
change, only what was said about it.

**The green badge is the one claim this interface makes on its own behalf**, and
it is made in exactly one situation: every figure in the answer was matched
against a value in a query result. A fallback answer says "showing verified data
only", a stopped one says it was stopped, and an answer with no figures in it —
which is what a refusal is — says there was nothing to verify. None of them is
green.

A chart is drawn from a fenced block the model writes, parsed by a schema the
prompt is generated from, so the instruction and the reader cannot drift. It is
never the only place a figure appears: the model is told to write the table as
well, and the table is what the verifier checked — which is what makes a chart
that fails to render cost nothing but the picture. A block that does not parse
stays a code block, because half the JSON is what most of the stream looks like.

**Effects clean up.** Every subscription, timer and request is created with an
`AbortController` and aborted on unmount. This is not hypothetical tidiness:
React's StrictMode mounts each component twice in development, so the first
request really is cancelled on every page load, and a missing cleanup shows up
as a state update on an unmounted tree rather than as an obvious bug.

Which is why **the page attaches again whenever the connection it had is gone**,
rather than once per message. The teardown between those two passes aborts
whatever the first one opened, and a page that only remembered having attached
would be left holding a connection that no longer exists — reading nothing, with
"Working on it…" on screen for as long as the tab is open. What is remembered is
which answer is being read; whether a connection is open is asked.

A dropped connection is not the same as a refusal. Anything the server answers
in the four hundreds — the message is gone, it was never this person's, the
session could not be saved — ends the attempt and says so, because asking eight
more times cannot make it answer differently. Five hundreds, and no response at
all, are what the backoff is for.

The caret at the end of an answer means **this page is receiving those words**,
not that a row says `generating`. A stored message can be unfinished with nobody
reading it, and a caret blinking beside a message saying the connection is gone
would claim two opposite things at once.

## What asking has cost

A meter in the rail, beside the person it belongs to — not in the bar above,
which is on the sign-in screen too, where there is nobody to have spent
anything.

**It is written to, not polled.** A budget only moves when something is
generated, and this page is the thing generating: the stream says what the
window looks like once, at the end of an answer, and that is put straight where
the meter reads it. Asking the server the same question again would be a request
for an answer already in hand. The other thing that moves it is a refusal, and
that one cannot say by how much — the failure shape is a code, a sentence and a
request id, deliberately — so a `budget_exceeded` is the one case that reads the
window again.

**Nothing here works out whether another question will fit.** What is left is a
subtraction, and there is one function for it in `@fca/contracts` used by both
sides, so a meter fed by an event and a meter fed by a page load cannot
disagree. But whether the _next_ answer fits is not a subtraction: a generation
holds what it might cost before it starts, so a window with a fraction of a cent
in it is spent for every practical purpose, and only the server knows what the
next one would hold. It says so, and the composer shuts on being told —
`exceeded` means "another answer will not fit", not "nothing is left".

The banner counts down rather than saying "later", because the only thing worth
knowing is whether to wait or to go away, and it unlocks itself when the window
turns over: somebody who waited should not have to reload to find out they were
right to. The clock behind it runs only while it is on screen — left running it
would re-render the shell once a second for as long as the application is open,
to move a number nobody is looking at.

Money crosses the wire as an integer count of micro-USD in a string and becomes
a number in exactly one file, at the last moment, for display. Amounts round
**up** to the cent: `$0.00` beside a bar that has moved reads as a meter that
does not work.

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

**Every screen is rendered inside `StrictMode`, and inside it at the root**, the
way `main.tsx` does. React only double-invokes effects for a `StrictMode` that is
the root of the render: one nested under a provider is measurably inert, so a
test that wraps the component alone is testing nothing. Effects mounting, being
torn down and mounting again is the shape that opens two connections to one
stream, or leaves a page holding none, so it belongs in every test rather than in
the two that remembered to ask for it. It also means "the first request" is not
something a test can name — a test that needs one call to fail says so with a
state it controls, not by counting.

The stubbed `fetch` honours the `AbortSignal`, because the real one does. One
that answered a request whose caller had gone would let a torn-down page go on
dispatching what it read, and no test could see it.

The example questions on the empty screen are checked against
`data/financial_data.sql`: each names a company and years the seed holds. It is
the only copy in the browser that says anything about the data, so it is the only
copy that can drift away from it — and an invitation answered with "this dataset
does not include it" is the worst first answer this application can give.

Coverage includes this package at the same 95% threshold as everything else.
`main.tsx` is the single exclusion: it mounts into a real document, which a unit
test cannot do without becoming a worse copy of opening the page.
