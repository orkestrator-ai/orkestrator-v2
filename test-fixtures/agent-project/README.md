# Orkestrator agent-test fixture

This repository is copied into an isolated development profile. Run `bun run dev`,
open the printed loopback URL, check `/health`, and use the click counter for a
deterministic interaction. Change the `fixture-v1` marker to exercise Git diff
and status refresh behavior.

## Annotation fixture

`bun run annotations` serves a synthetic page for web-annotation testing
(default `http://127.0.0.1:4174/settings`; `PORT` overrides). Start at
`/settings` in a 1280×800 viewport; 480 px wide shows the narrow layout. It has
a settings form, pricing cards, identical repeated buttons, nested elements,
long text, a wide table that overflows, an iframe, a shadow root, and a canvas.
Every value on it is synthetic, including the password and token fields and
the page strings that imitate agent instructions or annotation payloads.

`POST /__fixture/reset` restores the initial state; `POST /__fixture/state`
reorders or duplicates cards server-side. In the page,
`window.__annotationFixture` replaces or reorders elements like a hot reload.

The expected change for an implementation request is in
`annotation-app/fixture-data.ts` (`EXPECTED_SOURCE_CHANGE`): the Team plan
button label in `annotation-app/content.ts`. `bun run annotations:verify`
checks the source and the rendered page (`--expect=original` checks the
baseline).
