import { test as base } from "@playwright/test";
import { stopOwnedProcessGroups } from "../process-cleanup";

export { expect } from "@playwright/test";

/**
 * `test` for the Electron specs that spawn detached servers (Vite and the
 * like). Spawn them through `ownProcessGroup` so they are stopped even when a
 * test times out: Playwright then abandons the test body, so its `finally`
 * never runs, but it still tears down worker fixtures before the worker exits.
 * Anything this teardown cannot reach (a teardown that itself times out) is
 * killed by the exit hook `ownProcessGroup` installs.
 */
export const test = base.extend<object, { ownedProcessGroups: void }>({
  ownedProcessGroups: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads fixture dependencies from this destructuring.
    async ({}, use) => {
      await use();
      await stopOwnedProcessGroups();
    },
    { scope: "worker", auto: true },
  ],
});
