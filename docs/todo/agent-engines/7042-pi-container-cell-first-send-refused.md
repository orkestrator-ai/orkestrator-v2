# Pi container cell: a first prompt refused once

## Task analysis

Analysed 2026-11-06 against `main` at `295abd298`.

### Tasks

1. **Find why the Pi cell's first prompt came back to the composer**: one run of the Docker fixture's Pi cell had its first prompt refused within a second, cause unknown. Status: open (needs a reproduction with logs kept).

### 1. Find why the Pi cell's first prompt came back to the composer

**Problem.** In the second of three `mise run test:agent:docker:isolated` runs on beelink on 2026-11-06, the Pi cell (`e2e/agent-testing/container-fake-engines.spec.ts`, "Docker fixture Pi cell …") pressed Enter on its first prompt. The composer went disabled for under a second, then came back enabled with the prompt still in it. Nothing was resent, and the case timed out waiting for the composer to clear. The Cursor cell, which runs the same steps just before it, passed in that run. The Pi cell passed in the address-stage run that day and in the third run, which used the same image and host.

**Context.** The cell swaps `/opt/pi-bridge/dist/index.js` in the fixture container for the fake-engine bundle. It then saves a one-tab layout, reloads, and sends from a new tab, so the first send creates the Pi session through the backend's production `start_pi_server` launch. The Pi setup-failure case runs earlier in the same worker. It starts the fake through `start_pi_server`, then stops it and restores the real entry. A refused send keeps its draft and shows the reason through `submissionError` or `sendError` (`apps/web/src/components/native-agent/AgentNativeTab.controller.tsx`, `AgentNativeTab.tsx`). Before dispatch, the reason can be a lock or persistence failure. After dispatch, it is a rejected `dispatchNativeAgentIntent`.

**Investigation.** The run's profile was reset by the isolated runner before its backend, bridge and Electron logs were read. The Playwright error context holds only the composer's state, so the refusal's text is unknown. The spec's send step now records the visible alert text and the projection's turn phase and error as a `send-refused` annotation. It then resends once, but only when the projection shows no user message with that prompt, so nothing can run twice. The third run passed without the annotation.

**Decisions.**

- **How to find the cause?**
  - **Watch the `send-refused` annotation in later Docker runs. When it appears, rerun the Pi cell alone on a kept profile (`dev:test --fixture --fixture-environments container`, without the isolated runner's reset) and read `<logDir>/backend.log` and the container's `pi-bridge` log (recommended).**
    - Pros: costs nothing until the refusal recurs, and the annotation already captures the text the UI showed.
    - Cons: it may never recur on demand.
  - **Make the isolated runner keep the profile's log directory after a failed browser run.**
    - Pros: every failure's logs survive.
    - Cons: changes shared harness behaviour, and each log directory must be checked for secrets before it is kept.

## Needs verification

- Whether the refusal came before dispatch (lock or persistence) or from the bridge (a rejected dispatch), and whether it is specific to a Pi bridge that the setup-failure case had started and stopped just before.

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md) task 8 (the cells and the validation record).
- [7040-container-cells-on-real-cursor-and-pi.md](7040-container-cells-on-real-cursor-and-pi.md).
