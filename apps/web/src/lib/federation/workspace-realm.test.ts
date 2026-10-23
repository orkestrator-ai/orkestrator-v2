import { afterEach, expect, test } from "bun:test";
import {
  isWorkspaceRealm,
  parseRealmMessage,
  parseShellMessage,
  readFrameEnvelope,
  realmInitialRequest,
  realmSearchParams,
  realmWorkspaceId,
} from "./workspace-realm";

const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
const originalHref = window.location.href;

afterEach(() => happyDOM.setURL(originalHref));

test("a realm is recognised and opens on its URL's selection; the window is not a realm", () => {
  expect(isWorkspaceRealm()).toBe(false);
  expect(realmInitialRequest()).toBeNull();
  const search = realmSearchParams({ projectId: "p", environmentId: "e" });
  search.set("workspace", "w1");
  happyDOM.setURL(`https://command.test/?${search.toString()}`);
  expect(isWorkspaceRealm()).toBe(true);
  expect(realmWorkspaceId()).toBe("w1");
  expect(realmInitialRequest()).toEqual({ type: "select", projectId: "p", environmentId: "e" });
});

test("only known messages with bounded IDs cross between a window and its realm", () => {
  expect(parseShellMessage({ type: "select", environmentId: "e" })).toEqual({ type: "select" });
  expect(parseShellMessage({ type: "select", projectId: "x".repeat(300) })).toEqual({
    type: "select",
  });
  expect(parseShellMessage({ type: "sidebar", open: "yes" })).toBeNull();
  expect(parseShellMessage({ type: "navigate", url: "https://evil.example" })).toBeNull();
  expect(parseRealmMessage({ type: "selection", projectId: null, environmentId: "e" })).toEqual({
    type: "selection",
    projectId: null,
    environmentId: null,
  });
  expect(parseRealmMessage({ type: "settings", section: "../general" })).toBeNull();
  expect(parseRealmMessage({ type: "open", nodeId: "bk_a" })).toBeNull();
  expect(readFrameEnvelope({ kind: "other", workspaceId: "w", message: {} })).toBeNull();
});

test("title-bar popovers and meters cross only in their known shapes", () => {
  expect(parseShellMessage({ type: "panel", panel: "usage", open: true, inset: 48 })).toEqual({
    type: "panel",
    panel: "usage",
    open: true,
    inset: 48,
  });
  expect(parseShellMessage({ type: "panel", panel: "agent", open: false, inset: -5 })).toEqual({
    type: "panel",
    panel: "agent",
    open: false,
    inset: 0,
  });
  expect(parseShellMessage({ type: "panel", panel: "settings", open: true })).toBeNull();
  expect(parseShellMessage({ type: "panel", panel: "usage", open: "yes" })).toBeNull();

  expect(
    parseShellMessage({
      type: "panel",
      panel: "agent",
      open: false,
      inset: 6,
      seq: 42,
      restoreFocus: true,
    }),
  ).toEqual({ type: "panel", panel: "agent", open: false, inset: 6, seq: 42, restoreFocus: true });
  expect(parseRealmMessage({ type: "panelDismissed", panel: "usage", seq: 42 })).toEqual({
    type: "panelDismissed",
    panel: "usage",
    seq: 42,
  });
  for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "42", undefined]) {
    expect(parseRealmMessage({ type: "panelDismissed", panel: "usage", seq })).toBeNull();
  }
  expect(parseRealmMessage({ type: "panelDismissed", panel: "settings", seq: 42 })).toBeNull();
  expect(parseRealmMessage({ type: "titleBar", panel: "agent", requestSeq: 42 })).toMatchObject({
    panel: "agent",
    requestSeq: 42,
  });

  const usage = {
    cpuPercent: 31,
    ramPercent: 73,
    gpuPercent: null,
    diskPercent: 59,
    sampledAt: "2026-10-23T12:00:00.000Z",
  };
  expect(parseRealmMessage({ type: "titleBar", usage, usageStale: true, panel: "agent" })).toEqual({
    type: "titleBar",
    usage,
    usageStale: true,
    panel: "agent",
  });
  // A malformed reading is no reading; an unknown popover is none.
  expect(
    parseRealmMessage({
      type: "titleBar",
      usage: { cpuPercent: "31", ramPercent: 73, sampledAt: "now" },
      usageStale: "no",
      panel: "other",
    }),
  ).toEqual({ type: "titleBar", usage: null, usageStale: false, panel: null });
});
