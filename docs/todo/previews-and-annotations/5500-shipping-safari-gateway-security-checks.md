# Pass the gateway security spec's H1, M1 and M2 cases in shipping Safari

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`.

Left over from the security report's [§8 dynamic testing](../../reports/2-26-10-27-security.md#8-not-covered--follow-up). The report's other live checks ran on 2026-11-05 ([record](../../development/container-qualification.md#gateway-reach-and-project-seed-files-on-linux-engine-2026-11-05)).

### Tasks

1. **Pass H1, M1 and M2 in shipping Safari**: the spec passes in Playwright's WebKit, which is not Safari. Status: open.

### 1. Pass H1, M1 and M2 in shipping Safari

**Problem.** The H1, M1 and M2 fixes rely on what a browser does with cookies and the sandbox header, and Safari has its own cookie policy on top of the WebKit engine.

**Context.** `e2e/preview/gateway-browser-security.spec.ts` covers cookie scope across ports, `SameSite=Strict` on typed and cross-site navigations, the sandbox header on a top-level load, and credentials from `Origin: null`. It is part of `mise run test:preview:browser`. Shipping Safari is also open in [todo 0042](0042-service-preview-rollout.md) task 3. A pass or a failure here also answers the Safari line under Needs verification in [security report 0020](../../reports/security/0020-m1-isolated-preview-default.md).

**Investigation.** On 2026-11-04 all 21 cases passed: seven each in Chromium, Firefox and WebKit, on macOS. Safari itself was not run. No harness in this repository drives it, and `safaridriver` needs **Allow Remote Automation** turned on in Safari's settings. This needs a Mac: the run that closed the rest of the report on 2026-11-05 was on a Linux host.

**Decisions.**

- **How to run it?**
  - **By hand, alongside todo 0042 task 3, against `apps/backend/src/gateway-browser-harness.ts` (recommended).**
    - Pros: the same fixture as the spec; no new harness; one Safari pass serves both items.
    - Cons: no regression guard for Safari beyond the WebKit run.
  - **A `safaridriver` project in the spec's Playwright setup.**
    - Pros: repeatable.
    - Cons: Playwright does not drive it, so this is a second harness, and it needs a system setting changed on every machine that runs it.

## Related

- [Security report, §8](../../reports/2-26-10-27-security.md#8-not-covered--follow-up)
- [Todo 0042](0042-service-preview-rollout.md), task 3
- `docs/architecture/remote-gateway.md`, Security notes

## Replaces

Task 1 of security report 0260, which was deleted once its other two checks had run.
