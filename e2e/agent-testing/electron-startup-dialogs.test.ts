import { expect, test } from "bun:test";
import type { ElectronApplication } from "playwright";
import { dismissStartupDialogs } from "./electron-startup-dialogs";

type Handler = (locator: unknown) => Promise<unknown>;

/** A page that records its locator handlers by the button name they match. */
function fakeApp() {
  const handlers = new Map<string, Handler>();
  const page = {
    getByRole: (_role: string, { name }: { name: string }) => ({ name }),
    addLocatorHandler: async (locator: { name: string }, handler: Handler) => {
      handlers.set(locator.name, handler);
    },
  };
  const app = { windows: () => [page], on: () => undefined };
  return { app: app as unknown as ElectronApplication, handlers };
}

test("a startup button that leaves the page under the click does not fail the action that found it", async () => {
  const { app, handlers } = fakeApp();
  dismissStartupDialogs(app);
  const handler = handlers.get("Continue Without GitHub CLI")!;
  expect(handler).toBeDefined();
  const timeouts: Array<number | undefined> = [];
  // As Playwright's click does when its target is gone: it waits out its timeout and throws.
  const vanished = {
    click: async (options?: { timeout?: number }) => {
      timeouts.push(options?.timeout);
      throw new Error("locator.click: Timeout exceeded");
    },
  };
  await expect(handler(vanished)).resolves.toBeUndefined();
  expect(timeouts).toEqual([5_000]);
});

test("a startup button that is still there is clicked", async () => {
  const { app, handlers } = fakeApp();
  dismissStartupDialogs(app);
  let clicks = 0;
  await handlers.get("Continue Without Docker")!({
    click: async () => {
      clicks += 1;
    },
  });
  expect(clicks).toBe(1);
});

test("reachability warning closes through its own Close button", async () => {
  const { app, handlers } = fakeApp();
  dismissStartupDialogs(app);
  const handler = handlers.get("Docker containers can't reach Orkestrator");
  expect(handler).toBeDefined();
  const actions: string[] = [];
  await handler!({
    getByRole: (role: string, options: { name: string; exact: boolean }) => {
      actions.push(`${role}:${options.name}:${options.exact}`);
      return {
        last: () => ({
          click: async () => {
            actions.push("click");
          },
        }),
      };
    },
  });
  expect(actions).toEqual(["button:Close:true", "click"]);
});
