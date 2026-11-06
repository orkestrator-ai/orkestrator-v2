import { afterEach, describe, expect, mock, test } from "bun:test";
import { recordRealmBootStep, resetRealmBootTimingForTests } from "./realm-boot-timing";

const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
const originalUrl = window.location.href;
const originalApi = window.orkestrator;

function asDesktopRealm(post: (message: unknown) => void): void {
  happyDOM.setURL("https://command.test/?realm=workspace");
  window.orkestrator = {
    ...originalApi,
    workspaceRealm: { post, onMessage: () => () => undefined },
  } as typeof window.orkestrator;
}

afterEach(() => {
  happyDOM.setURL(originalUrl);
  window.orkestrator = originalApi;
  resetRealmBootTimingForTests();
});

describe("recordRealmBootStep", () => {
  test("posts each step once to the desktop, with only durations and fixed fields", () => {
    const post = mock((_message: unknown) => {});
    asDesktopRealm(post);

    recordRealmBootStep("first-environments", 812.4, { outcome: "ok" });
    recordRealmBootStep("first-environments", 99);
    recordRealmBootStep("fan-out-complete", 2_000, { requests: 17 });

    expect(post.mock.calls.map(([message]) => message)).toEqual([
      {
        type: "bootTiming",
        step: "first-environments",
        durationMs: 812,
        sinceStartMs: expect.any(Number),
        outcome: "ok",
      },
      {
        type: "bootTiming",
        step: "fan-out-complete",
        durationMs: 2_000,
        sinceStartMs: expect.any(Number),
        requests: 17,
      },
    ]);
  });

  test("does nothing outside a workspace realm", () => {
    const post = mock((_message: unknown) => {});
    asDesktopRealm(post);
    happyDOM.setURL("https://command.test/");
    recordRealmBootStep("first-render", 10);
    expect(post).not.toHaveBeenCalled();
  });
});

test("first render duration starts at the startup entry point rather than document navigation", async () => {
  const { spyOn } = await import("bun:test");
  const { beginRealmBoot, recordRealmFirstRender } = await import("./realm-boot-timing");
  const post = mock((_message: unknown) => {});
  asDesktopRealm(post);
  const clock = spyOn(globalThis.performance, "now");
  try {
    clock.mockReturnValue(5_000);
    beginRealmBoot();
    clock.mockReturnValue(5_125);
    recordRealmFirstRender();
    recordRealmFirstRender();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({
      type: "bootTiming",
      step: "first-render",
      durationMs: 125,
      sinceStartMs: 5_125,
    });
  } finally {
    clock.mockRestore();
  }
});
