# Run the outstanding dynamic security checks

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **H1, M1 and M2 in Chromium and Safari**: the browser behaviour the fixes depend on. Status: open.
2. **H3 on rootful and rootless Docker**: the seed-file path against real daemons. Status: open.

### 1. H1, M1 and M2 in Chromium and Safari

**Problem.** The report marked these as depending on browser rules it did not exercise, and its §8 keeps that open: cookie scope across ports, `SameSite=Strict` on a typed navigation, the sandbox header on a top-level load, and credentials on `Origin: null`.

**Context.** The fixes have backend tests that go through a real gateway (`apps/backend/tests/gateway-preview.test.ts`, `apps/backend/tests/gateway-proxy.test.ts`), but those do not show what a browser does with the headers.

**Investigation.** Playwright specs touch these areas: `e2e/preview/vite-page-load.spec.ts:151` and `e2e/preview/upstream-pool.spec.ts:96` load legacy URLs, and `e2e/preview/private-origin.spec.ts:387-393` and `:480` log in and check that the cookie does not reach a preview. Not read in full: whether any of them asserts an opaque origin on a top-level legacy load, or sends the cookie to another port. Safari remains blocked on hardware in [todo 0042](../../todo/previews-and-annotations/0042-service-preview-rollout.md) task 3.

**Decisions.**

- **How to record the result?**
  - **Add one Playwright spec per property, and run it in Chromium and WebKit (recommended).**
    - Pros: repeatable; the suite already has fixtures for the gateway and legacy URLs.
    - Cons: WebKit is not shipping Safari, so a manual Safari pass is still needed.
  - **A one-off manual pass, recorded in the report.**
    - Pros: quick; exact browsers.
    - Cons: no regression guard.

### 2. H3 on rootful and rootless Docker

**Problem.** The original concern was how a daemon resolves a symlinked bind source. The fix no longer binds those files, so the question becomes whether seed files arrive correctly and refusals hold on real daemons.

**Context.** `readProjectSeedFiles` refuses links in the host process (`apps/backend/src/core/container-project-seed-files.ts:66-110`) and files then go in by `docker cp`. The refusal itself does not depend on Docker.

**Investigation.** `apps/backend/tests/container-project-seed-docker.test.ts` exists as a live test. Whether it has been run on rootless was not established from the code.

**Decisions.** None: run the existing test on both daemon types, and record the result in `docs/development/container-qualification.md`.

## Needs verification

All of this file is by nature unobserved: nothing was run for it.

## Related

- [Security report, §8](../2-26-10-27-security.md#8-not-covered--follow-up)
- [0010](0010-h1-gateway-cookie-remainder.md), [0020](0020-m1-isolated-preview-default.md)
- [Todo 0042](../../todo/previews-and-annotations/0042-service-preview-rollout.md), task 3
