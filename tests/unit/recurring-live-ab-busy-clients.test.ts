import { afterEach, expect, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { pageClient, playwrightBusyClients } from "../../scripts/recurring-live-ab-busy-clients";

afterEach(() => {
  document.body.innerHTML = "";
});

test("page readers parse sidebar, replies and mail and fall back during navigation", async () => {
  document.body.innerHTML = `<div role="button"><span id="env">fixture</span><i data-testid="environment-status-marker" data-state="working"></i><span data-testid="environment-change-badge">+1,234 -2</span></div><div data-chat-message-index="0">Soak reply.</div><button aria-label="Agent mail: 3 messages in inbox"></button>`;
  let navigating = false;
  const page = {
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
      if (navigating) throw new Error("navigation");
      return fn(arg);
    },
    getByRole: () => ({
      getByRole: () => ({ first: () => ({ isVisible: async () => !navigating }) }),
    }),
  } as unknown as Page;
  const client = pageClient(
    "test",
    page,
    { close: async () => {} } as unknown as BrowserContext,
    undefined,
  );
  expect(await client.markerState("fixture")).toBe("working");
  expect(await client.markerState("missing")).toBeNull();
  expect(await client.badges()).toEqual({ fixture: 1234 });
  expect(await client.replyCount()).toBe(1);
  expect(await client.mailCount()).toBe(3);
  expect(await client.approvalVisible()).toBe(true);
  await client.setHidden(true);
  expect(document.hidden).toBe(true);
  await client.setHidden(false);
  navigating = true;
  expect(await client.markerState("fixture")).toBeNull();
  expect(await client.badges()).toEqual({});
  expect(await client.replyCount()).toBe(0);
  expect(await client.mailCount()).toBe(0);
  expect(await client.approvalVisible()).toBe(false);
});

test("factory authenticates and closes its context when opening the tab fails", async () => {
  let closed = 0;
  let browserClosed = 0;
  let visited = "";
  const page = {
    setDefaultTimeout: () => {},
    goto: async (url: string) => {
      visited = url;
      return { ok: () => true };
    },
  } as unknown as Page;
  const factory = playwrightBusyClients(
    "fixture",
    { browserUrl: "http://127.0.0.1:1234", rendererUrl: "http://127.0.0.1:1235" },
    undefined,
    {
      launch: async () =>
        ({
          newContext: async () => ({
            newPage: async () => page,
            close: async () => {
              closed += 1;
            },
          }),
          close: async () => {
            browserClosed += 1;
          },
        }) as unknown as Browser,
      loginPath: () => "/bootstrap?code=fixture",
      openTab: async () => {
        throw new Error("tab unavailable");
      },
    },
  );
  await expect(factory.open({ count: 1, openEnvironment: "fixture" })).rejects.toThrow(
    "tab unavailable",
  );
  expect(visited).toBe("http://127.0.0.1:1234/bootstrap?code=fixture");
  expect(closed).toBe(1);
  await factory.close();
  expect(browserClosed).toBe(1);
});

test("factory reuses its browser with separate authenticated contexts and closes each", async () => {
  let launches = 0;
  let closes = 0;
  let opens = 0;
  const page = {
    setDefaultTimeout: () => {},
    goto: async () => ({ ok: () => true }),
  } as unknown as Page;
  const factory = playwrightBusyClients(
    "fixture",
    { browserUrl: "http://127.0.0.1:1234", rendererUrl: "http://127.0.0.1:1235" },
    undefined,
    {
      launch: async () => {
        launches += 1;
        return {
          newContext: async () => ({
            newPage: async () => page,
            close: async () => {
              closes += 1;
            },
          }),
          close: async () => {},
        } as unknown as Browser;
      },
      loginPath: () => "/bootstrap",
      openTab: async () => {
        opens += 1;
      },
    },
  );
  for (let round = 0; round < 2; round += 1) {
    const clients = await factory.open({ count: 1, openEnvironment: "fixture" });
    await clients[0]!.close();
  }
  expect(launches).toBe(1);
  expect(opens).toBe(2);
  expect(closes).toBe(2);
  await factory.close();
});
