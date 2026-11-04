# Design frames throw `Invalid URL` when the page URL has no origin

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`, from the default suite of the branch for 1202 task 3 (which does not touch `apps/web/src/components/design/`).

### Tasks

1. **Resolve the page base only when a frame document is configured**: stop `designFrameSource` parsing the page URL on the `srcdoc` path. Status: open.

### 1. Resolve the page base only when a frame document is configured

**Problem.** `designFrameSource` in `apps/web/src/components/design/design-frame-source.ts` computes `new URL("/", pageUrl)` before it checks whether a frame document is configured. Under the web test preload, Happy DOM is registered with no URL, so `window.location.href` is `about:blank` and that call throws `TypeError: Invalid URL`. Every test that renders `DesignFrameView` or `DesignCheckpointPreview` fails, and the default suite (`mise run test`) is red.

**Context.** The function arrived in `96ee1eb3e` (security report 2fa8106d37c3 r1, #1722). A production renderer always has an `http(s):` or `file:` page URL, so no user-visible failure is known; the `srcdoc` path needs no base at all.

**Investigation.** On the 1202 task 3 branch, `bun --cwd=apps/web test src/components/design --parallel=4` gave 311 pass, 48 fail; 44 failures are `TypeError: Invalid URL` thrown at `design-frame-source.ts:15`, and the other four (`DesignHistoryPanel` text lookups and one "Should not already be working") follow from those renders failing. A temporary, uncommitted change that returns `{ srcDoc }` before computing the base made the same command pass 359 of 359. `DesignFrameView.bridge.test.tsx` alone fails 5 of 5 with the same error. That branch's diff contains no file under `apps/web/src/components/design/`, `tests/register-dom.ts`, `tests/setup.ts` or `apps/web/bunfig.toml`.

**Decisions.**

- **Where to fix it?**
  - **Return the `srcdoc` form before resolving the base (recommended).**
    - Pros: one line; the `srcdoc` path never needed the page URL; production behaviour is unchanged.
    - Cons: an invalid page URL with a configured document still throws, which is what it should do.
  - **Register Happy DOM with an `http://localhost/` URL in `tests/register-dom.ts`.**
    - Pros: tests see a realistic location.
    - Cons: changes the location every web test sees, so other suites that rely on `about:blank` could change behaviour.

## Related

- [1202 efficiency follow-ups](../cross-cutting/1202-efficiency-review-follow-ups.md), task 3 (where the failures were recorded)
