# `design-canvas.spec.ts` does not dismiss the Docker reachability dialog

Found on 2026-11-03 while qualifying
[2181](2181-dev-test-electron-opens-on-the-linux-desktop.md) on beelink.

## Task analysis

Analysed 2026-11-03 against `main` at `4d9ff8690`.

### Tasks

1. **Close the reachability dialog in the design canvas browser spec**: on a host whose firewall drops Docker's traffic to the host, the modal covers the page and every case in the spec fails. Status: open.

### 1. Close the reachability dialog in the design canvas browser spec

**Problem.** `mise run test:agent:design:isolated` failed all three cases of `e2e/agent-testing/design-canvas.spec.ts` on beelink. The first failed at `New file: designs/preview.orkdes will be created.` not being visible (line 161), and the page snapshot at each of the three failures shows the "Docker containers can't reach Orkestrator" modal.

**Context.** The backend's boot-time reachability check opens that modal a few seconds after startup on a host whose firewall drops Docker's traffic to the host, as beelink's ufw does (`firewall=ufw`, `status=blocked` in the backend log). `browser-gateway.spec.ts:123` and `container-wiring-support.ts:100` close it, and `electron-startup-dialogs.ts` does so for the Electron specs after to-do 0036 hit the same thing. `design-canvas.spec.ts` has no handler for it.

**Investigation.** One run, on a `dev:test --headless` profile from the runner (`--fixture --headless --no-agent-credentials --agent-platforms codex`). Headless is not the cause as far as the code shows: the modal comes from the backend's check, not from Electron, but this has not been run on a host without the firewall rule or on `main`. The attribution of all three failures to the modal rests on the page snapshots, not on a run with the modal closed.

**Decisions.**

- **Where should the dialog be handled?**
  - **A locator handler in `design-canvas.spec.ts`, using the same dialog name and Close control as `browser-gateway.spec.ts` (recommended).**
    - Pros: small, and matches the existing specs.
    - Cons: another copy of the handler, of which there are already several.
  - **One shared helper for every browser spec.**
    - Pros: a later spec cannot forget it.
    - Cons: touches every spec that has its own copy; a bigger change than this failure needs.
  - **Open the firewall on the host.**
    - Pros: no code; the modal's own instructions cover it.
    - Cons: changes a host setting to pass a test, and leaves the spec failing on the next such host.

## Needs verification

- With the handler, the spec passes on beelink. Check whether its cases need the page after the modal closes, since the spec is timing-sensitive on narrow layouts (flakes 0209 and 0632).

## Related

- [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md), whose qualification found this.
- Flake [4250](../../tests/flaky-tests/design-canvas-and-artifacts/4250-design-electron-reachability-dialog-race.md), the same modal in the Electron journey, though there it has a handler.
