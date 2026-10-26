import { afterEach, expect, test } from "bun:test";
import {
  isWorkspaceRealm,
  parseRealmMessage,
  parseShellMessage,
  readFrameEnvelope,
  realmCoordinatorDefers,
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
  expect(parseShellMessage({ type: "grouping", grouping: "repository" })).toEqual({
    type: "grouping",
    grouping: "repository",
  });
  expect(parseShellMessage({ type: "grouping", grouping: "activity" })).toEqual({
    type: "grouping",
    grouping: "activity",
  });
  expect(parseShellMessage({ type: "grouping", grouping: "unknown" })).toBeNull();
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

test("a dialog request crosses only with what it opens on", () => {
  expect(parseShellMessage({ type: "select", projectId: "p", dialog: "delete-project" })).toEqual({
    type: "select",
    projectId: "p",
    dialog: "delete-project",
  });
  expect(
    parseShellMessage({
      type: "select",
      projectId: "p",
      environmentId: "e",
      dialog: "environment-settings",
    }),
  ).toEqual({ type: "select", projectId: "p", environmentId: "e", dialog: "environment-settings" });
  // An environment's settings need the environment; any dialog needs a project.
  expect(
    parseShellMessage({ type: "select", projectId: "p", dialog: "environment-settings" }),
  ).toEqual({ type: "select", projectId: "p" });
  expect(
    parseShellMessage({
      type: "select",
      projectId: "p",
      environmentId: "e",
      dialog: "environment-rebuild",
    }),
  ).toEqual({ type: "select", projectId: "p", environmentId: "e", dialog: "environment-rebuild" });
  expect(
    parseShellMessage({ type: "select", projectId: "p", dialog: "environment-rebuild" }),
  ).toEqual({ type: "select", projectId: "p" });
  expect(parseShellMessage({ type: "select", dialog: "repository-settings" })).toEqual({
    type: "select",
  });
  expect(parseShellMessage({ type: "select", projectId: "p", dialog: "format-disk" })).toEqual({
    type: "select",
    projectId: "p",
  });
  const search = realmSearchParams({ projectId: "p", dialog: "repository-settings" });
  expect(search.get("dialog")).toBe("repository-settings");
});

test("a realm's coordinator defers to the command node only when grouped by repository", () => {
  expect(realmCoordinatorDefers("repository")).toBe(true);
  // Not yet told by the window: keep deferring rather than flash the conversations.
  expect(realmCoordinatorDefers(null)).toBe(true);
  expect(realmCoordinatorDefers("machine")).toBe(false);
  expect(realmCoordinatorDefers("project")).toBe(false);
  expect(realmCoordinatorDefers("activity")).toBe(false);
});

test("explicit board intent survives realm URLs and messages, with only known tabs accepted", () => {
  for (const boardTab of ["coordinator", "kanban", "github", "linear", "features"] as const) {
    const selection = { projectId: "p", boardTab };
    happyDOM.setURL(`https://command.test/?${realmSearchParams(selection)}`);
    expect(realmInitialRequest()).toEqual({ type: "select", ...selection });
    expect(parseShellMessage({ type: "select", ...selection })).toEqual({
      type: "select",
      ...selection,
    });
    const open = { type: "open" as const, nodeId: "leaf", ...selection, title: "Project" };
    expect(parseRealmMessage(open)).toEqual(open);
  }
  expect(parseShellMessage({ type: "select", projectId: "p", boardTab: "unknown" })).toEqual({
    type: "select",
    projectId: "p",
  });
  expect(parseShellMessage({ type: "select", boardTab: "coordinator" })).toEqual({
    type: "select",
  });
  expect(
    parseRealmMessage({ type: "open", nodeId: "leaf", projectId: "p", boardTab: "unknown" }),
  ).toEqual({ type: "open", nodeId: "leaf", projectId: "p", title: "" });
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
