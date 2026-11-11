import { afterEach, expect, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  pageClient,
  playwrightBusyClients,
  playwrightSoakReader,
  reviewTabIdSuffix,
  toProcessClock,
} from "../../scripts/recurring-live-ab-busy-clients";

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

test("the review tab suffix matches the renderer's tab element id", async () => {
  const { createPaneTabElementId } = await import("../../apps/web/src/types/paneLayout");
  // The backend opens a review's root tab as `multi-review:<workflowId>`
  // (`openMultiReviewTab`); the renderer encodes it into the element id.
  expect(
    createPaneTabElementId("env-1", "default", "multi-review:wf/1").endsWith(
      reviewTabIdSuffix("wf/1"),
    ),
  ).toBe(true);
});

test("sightings move from the page's wall clock onto the process clock", () => {
  expect(
    toProcessClock(
      [
        { phase: "preparing", at: 9_000 },
        { phase: "reviewing", at: 9_750 },
      ],
      10_000,
      500,
    ),
  ).toEqual([
    { phase: "preparing", at: -500 },
    { phase: "reviewing", at: 250 },
  ]);
});

/** A page whose `evaluate` runs in this test's DOM, with a scripted review tab. */
function reviewPage(options: { tabArrives: boolean; selected?: boolean }) {
  const calls: string[] = [];
  const page = {
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
    reload: async () => {
      calls.push("reload");
    },
    locator: (selector: string) => {
      calls.push(`locator ${selector}`);
      const tab = {
        first: () => tab,
        waitFor: async () => {
          if (!options.tabArrives) throw new Error("Timeout");
        },
        getAttribute: async () => (options.selected ? "true" : "false"),
        click: async () => {
          calls.push("click");
        },
      };
      return tab;
    },
  } as unknown as Page;
  return { page, calls };
}

test("a review view records the named review's visible phases from before its tab is selected", async () => {
  const original = Element.prototype.checkVisibility;
  Element.prototype.checkVisibility = function (this: Element) {
    return !this.closest("[hidden]");
  };
  const opened: string[] = [];
  let reviewClosed = 0;
  const view = reviewPage({ tabArrives: true });
  const client = pageClient(
    "c1",
    {} as Page,
    { close: async () => {} } as unknown as BrowserContext,
    undefined,
    {
      open: async (environment) => {
        opened.push(environment);
        return {
          page: view.page,
          context: {
            close: async () => {
              reviewClosed += 1;
            },
          } as unknown as BrowserContext,
        };
      },
      reopen: async () => {
        throw new Error("not expected");
      },
    },
  );
  try {
    await client.prepareReview("busy-2");
    await client.prepareReview("busy-2");
    expect(opened).toEqual(["busy-2"]);
    // An earlier round's review stays mounted; only this one is read.
    document.body.innerHTML = `<div hidden><span data-testid="multi-review-phase" data-phase="ready" data-workflow-id="wf-old"></span></div><span id="header" data-testid="multi-review-phase" data-phase="preparing" data-workflow-id="wf-2"></span>`;
    await client.watchReview("wf-2");
    expect(view.calls).toEqual([
      `locator [role="tab"][id$="${reviewTabIdSuffix("wf-2")}"]`,
      "click",
    ]);
    const header = document.getElementById("header")!;
    header.setAttribute("data-phase", "reviewing");
    await new Promise((resolve) => setTimeout(resolve, 0));
    header.setAttribute("data-phase", "consolidating");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sightings = await client.reviewPhases();
    expect(sightings.map((sighting) => sighting.phase)).toEqual([
      "preparing",
      "reviewing",
      "consolidating",
    ]);
    for (let index = 1; index < sightings.length; index += 1)
      expect(sightings[index]!.at).toBeGreaterThanOrEqual(sightings[index - 1]!.at);
    await client.close();
    expect(reviewClosed).toBe(1);
    // A closed view reads as nothing, never a throw.
    expect(await client.reviewPhases()).toEqual([]);
  } finally {
    (window as unknown as { __busyReviewStop?: () => void }).__busyReviewStop?.();
    Element.prototype.checkVisibility = original;
  }
});

test("a review tab that never arrives reloads the view once, then fails", async () => {
  const view = reviewPage({ tabArrives: false });
  let reopened = 0;
  const client = pageClient(
    "c1",
    {} as Page,
    { close: async () => {} } as unknown as BrowserContext,
    undefined,
    {
      open: async () => ({
        page: view.page,
        context: { close: async () => {} } as unknown as BrowserContext,
      }),
      reopen: async () => {
        reopened += 1;
      },
    },
  );
  try {
    await expect(client.watchReview("wf-1")).rejects.toThrow("no review view");
    await client.prepareReview("busy-2");
    await expect(client.watchReview("wf-1")).rejects.toThrow("Timeout");
    expect(view.calls).toContain("reload");
    expect(reopened).toBe(1);
    expect(view.calls).not.toContain("click");
  } finally {
    (window as unknown as { __busyReviewStop?: () => void }).__busyReviewStop?.();
  }
});

test("a selected review tab is not clicked again, and a client without views refuses", async () => {
  const view = reviewPage({ tabArrives: true, selected: true });
  const client = pageClient(
    "c1",
    {} as Page,
    { close: async () => {} } as unknown as BrowserContext,
    undefined,
    {
      open: async () => ({
        page: view.page,
        context: { close: async () => {} } as unknown as BrowserContext,
      }),
      reopen: async () => {},
    },
  );
  try {
    await client.prepareReview("busy-2");
    await client.watchReview("wf-1");
    expect(view.calls).not.toContain("click");
  } finally {
    (window as unknown as { __busyReviewStop?: () => void }).__busyReviewStop?.();
  }
  const bare = pageClient(
    "c2",
    {} as Page,
    { close: async () => {} } as unknown as BrowserContext,
    undefined,
  );
  await expect(bare.prepareReview("busy-2")).rejects.toThrow("has no review view");
});

test("factory opens a review view as its own signed-in context on the environment", async () => {
  const contexts: string[] = [];
  const environments: string[] = [];
  let visits = 0;
  const page = {
    setDefaultTimeout: () => {},
    goto: async () => {
      visits += 1;
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
          newContext: async () => {
            const id = `context-${contexts.length + 1}`;
            contexts.push(id);
            return {
              newPage: async () => page,
              pages: () => [page],
              close: async () => {
                contexts.push(`closed ${id}`);
              },
            };
          },
          close: async () => {},
        }) as unknown as Browser,
      loginPath: () => "/bootstrap",
      openTab: async () => {},
      selectEnvironment: async (_page, environment) => {
        environments.push(environment);
      },
    },
  );
  const [client] = await factory.open({ count: 1, openEnvironment: "busy-ask" });
  await client!.prepareReview("busy-2");
  expect(environments).toEqual(["busy-2"]);
  expect(visits).toBe(2);
  await client!.close();
  expect(contexts).toEqual(["context-1", "context-2", "closed context-2", "closed context-1"]);
  await factory.close();
});

test("soak reader closes each context whose sign-in fails and reuses a signed-in page", async () => {
  let contexts = 0;
  let closed = 0;
  let launches = 0;
  let browserClosed = 0;
  let signInOk = false;
  const selected: string[] = [];
  const tab = {
    waitFor: async () => {},
    click: async () => {},
  };
  const page = {
    setDefaultTimeout: () => {},
    goto: async () => ({ ok: () => signInOk }),
    screenshot: async () => undefined,
    getByRole: () => ({
      first: () => tab,
      nth: () => tab,
      count: async () => 2,
    }),
    waitForFunction: async () => {},
  } as unknown as Page;
  const reader = playwrightSoakReader(
    "fixture",
    { browserUrl: "http://127.0.0.1:1234" },
    undefined,
    {
      launch: async () => {
        launches += 1;
        return {
          newContext: async () => {
            contexts += 1;
            return {
              newPage: async () => page,
              close: async () => {
                closed += 1;
              },
            };
          },
          close: async () => {
            browserClosed += 1;
          },
        } as unknown as Browser;
      },
      loginPath: () => "/bootstrap",
      selectEnvironment: async (_page, environment) => {
        selected.push(environment);
      },
    },
  );
  await expect(reader.read("fixture")).rejects.toThrow("soak reader: sign-in failed");
  await expect(reader.read("fixture")).rejects.toThrow("soak reader: sign-in failed");
  // Every failed sign-in closed its own context; none is left open.
  expect(contexts).toBe(2);
  expect(closed).toBe(2);
  expect(selected).toEqual([]);

  signInOk = true;
  expect(await reader.read("fixture")).toBe(2);
  expect(await reader.read("other")).toBe(2);
  // The signed-in page is reused rather than opening a context per read.
  expect(contexts).toBe(3);
  expect(closed).toBe(2);
  expect(selected).toEqual(["fixture", "other"]);

  await reader.close();
  expect(closed).toBe(3);
  expect(browserClosed).toBe(1);
  expect(launches).toBe(1);
});

test("soak reader closes its context when sign-in throws before a response", async () => {
  let closed = 0;
  const reader = playwrightSoakReader(
    "fixture",
    { browserUrl: "http://127.0.0.1:1234" },
    undefined,
    {
      launch: async () =>
        ({
          newContext: async () => ({
            newPage: async () =>
              ({
                setDefaultTimeout: () => {},
                goto: async () => {
                  throw new Error("net::ERR_CONNECTION_REFUSED");
                },
              }) as unknown as Page,
            close: async () => {
              closed += 1;
            },
          }),
          close: async () => {},
        }) as unknown as Browser,
      loginPath: () => "/bootstrap",
    },
  );
  await expect(reader.read("fixture")).rejects.toThrow("ERR_CONNECTION_REFUSED");
  expect(closed).toBe(1);
  await reader.close();
  expect(closed).toBe(1);
});
