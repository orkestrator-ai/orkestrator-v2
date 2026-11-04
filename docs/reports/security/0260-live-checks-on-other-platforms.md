# Finish the security report's live checks on other platforms

## Task analysis

Analysed 2026-11-04 against `main` at `4e3caa079`.

What is left of the report's [§8 dynamic testing](../2-26-10-27-security.md#8-not-covered--follow-up). Everything one Mac with Docker Desktop could run has been run; these need another browser or another daemon.

### Tasks

1. **Pass H1, M1 and M2 in shipping Safari**: the spec passes in Playwright's WebKit, which is not Safari. Status: open.
2. **Run H3 on a rootless daemon**: the seed-file test passes on Docker Desktop only. Status: open.
3. **Check whether a container reaches the gateway on Linux Engine**: accepting the leaked-session exposure rests on the answer. Status: open.

### 1. Pass H1, M1 and M2 in shipping Safari

**Problem.** The H1, M1 and M2 fixes rely on what a browser does with cookies and the sandbox header, and Safari has its own cookie policy on top of the WebKit engine.

**Context.** `e2e/preview/gateway-browser-security.spec.ts` covers cookie scope across ports, `SameSite=Strict` on typed and cross-site navigations, the sandbox header on a top-level load, and credentials from `Origin: null`. It is part of `mise run test:preview:browser`. Shipping Safari is also open in [todo 0042](../../todo/previews-and-annotations/0042-service-preview-rollout.md) task 3.

**Investigation.** On 2026-11-04 all 21 cases passed: seven each in Chromium, Firefox and WebKit, on macOS. Safari itself was not run. No harness in this repository drives it, and `safaridriver` needs **Allow Remote Automation** turned on in Safari's settings.

**Decisions.**

- **How to run it?**
  - **By hand, alongside todo 0042 task 3, against `apps/backend/src/gateway-browser-harness.ts` (recommended).**
    - Pros: the same fixture as the spec; no new harness; one Safari pass serves both items.
    - Cons: no regression guard for Safari beyond the WebKit run.
  - **A `safaridriver` project in the spec's Playwright setup.**
    - Pros: repeatable.
    - Cons: Playwright does not drive it, so this is a second harness, and it needs a system setting changed on every machine that runs it.

### 2. Run H3 on a rootless daemon

**Problem.** The report asks for H3 on rootful and rootless Docker. Staged files have failed differently under rootless before, because the host user maps to container root.

**Context.** `readProjectSeedFiles` refuses links in the host process (`apps/backend/src/core/container-project-seed-files.ts`), so that refusal does not depend on Docker. Delivery by `docker cp` does.

**Investigation.** `apps/backend/tests/container-project-seed-docker.test.ts` passed on Docker Desktop 29.9.2 on 2026-11-04 ([recorded here](../../development/container-qualification.md#project-seed-files-and-gateway-reach-on-docker-desktop-2026-11-04)). No rootless daemon was available.

**Decisions.** None: run the same test with `ORKESTRATOR_SEED_TEST_IMAGE` on a rootless host and record the result in `docs/development/container-qualification.md`.

### 3. Check whether a container reaches the gateway on Linux Engine

**Problem.** `docs/architecture/remote-gateway.md` accepts that a leaked session works until it ends, because a restricted container cannot reach the gateway. That was observed on Docker Desktop only.

**Context.** A Linux Engine container reaches the host through the network's gateway address rather than Docker Desktop's forwarder, so the peer address and the route to a Tailscale address can both differ.

**Investigation.** On Docker Desktop a restricted container was refused at the gateway's port while its named service port answered, and a `full` mode container reached both, with the listener seeing peer `127.0.0.1` ([recorded here](../../development/container-qualification.md#project-seed-files-and-gateway-reach-on-docker-desktop-2026-11-04)). Linux Engine was not tried.

**Decisions.**

- **What if a restricted container reaches the gateway on Linux Engine?**
  - **Treat it as a firewall defect and fix the rule (recommended).**
    - Pros: the firewall already promises named ports only, so this restores the documented boundary without changing sessions.
    - Cons: none known; the check has not been run.
  - **Bind each session to the peer address that signed in.**
    - Pros: it would stop a stolen session used from a Docker bridge address.
    - Cons: Docker Desktop shows such a container as loopback, and Tailscale Serve shows every peer as loopback, so it does nothing on either.

## Related

- [Security report, §8](../2-26-10-27-security.md#8-not-covered--follow-up)
- [Todo 0042](../../todo/previews-and-annotations/0042-service-preview-rollout.md), task 3
- `docs/architecture/remote-gateway.md`, Security notes
