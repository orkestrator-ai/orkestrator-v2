# Check the preview publication domain against the app's site

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Tell the operator when a preview domain shares a site with the app**: the artifact content origin has this check and publication does not. Status: open.

### 1. Tell the operator when a preview domain shares a site with the app

**Problem.** A preview host that is same-site with the gateway can send same-site requests to it, and can set cookies on the shared parent, which allows the cookie tossing that [todo 2960](../../todo/cross-cutting/2960-host-prefixed-gateway-cookie.md) describes.

**Context.** The artifact content origin refuses this: `hostsShareSite` and its status reason (`apps/backend/src/core/transcript-artifacts/content-server.ts:102-108`, `:285`). Publication already treats sibling hosts as hostile among themselves (`docs/architecture/browser-previews.md:345-354`), and the gateway refuses other origins before processing.

**Investigation.** `apps/backend/src/preview-publication.ts:256-260` only checks the domain's form. Reusing the artifact check as it stands has a catch: the status message's example domain is `preview.example.ts.net` (`apps/backend/src/preview-publication.ts:258`), and `approximateSite` takes the last two labels (`apps/backend/src/core/transcript-artifacts/content-server.ts:85-99`). So every host under `ts.net` counts as one site, including a tailnet app and its own preview domain, and a refusal would block the setup the message recommends.

**Decisions.**

- **Refuse or warn?**
  - **Warn in the publication status (recommended).**
    - Pros: tells the operator without blocking the documented tailnet setup.
    - Cons: a warning can be ignored, and a real same-site deployment stays allowed.
  - **Refuse, as the artifact origin does, with `.ts.net` treated as a public suffix.**
    - Pros: matches the artifact rule.
    - Cons: needs a suffix exception. It would still refuse a preview domain under the app's own tailnet name, if that is the deployment some users have.

## Needs verification

- Which domain deployments are in use. Todo 0042 task 2 has a real private zone and wildcard certificate as a blocked prerequisite.

## Related

- [Security report, §6 Informational](../2-26-10-27-security.md#6-informational) (I5)
- [Todo 2960](../../todo/cross-cutting/2960-host-prefixed-gateway-cookie.md)
- [Todo 0042](../../todo/previews-and-annotations/0042-service-preview-rollout.md), task 2
