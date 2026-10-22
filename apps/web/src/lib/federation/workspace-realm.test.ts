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
