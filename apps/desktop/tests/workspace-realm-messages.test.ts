import { expect, mock, test } from "bun:test";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { postFromWorkspaceRealm } from "../electron/workspace-realm-messages";

test("main channel binds timing to its sender and consumes it before window forwarding", () => {
  const logs = captureLogs();
  const post = mock(() => {});
  const viewForWebContents = mock((id: number) =>
    id === 42 || id === 7 ? { scope: `realm-${id}` } : null,
  );
  const views = { post, viewForWebContents, msSinceOpened: mock(() => 50) };
  const realmBindings = new Map([
    ["realm-42", { target: { nodeId: "bound-node", nodeName: "Bound node" } }],
  ]);
  const timing = { type: "bootTiming", step: "first-render", durationMs: 12, nodeId: "forged" };
  try {
    postFromWorkspaceRealm(42, timing, views, realmBindings);
    expect(viewForWebContents).toHaveBeenCalledWith(42);
    expect(post).not.toHaveBeenCalled();
    expect(logs.records().map(({ fields }) => fields)).toEqual([
      {
        nodeId: "bound-node",
        nodeName: "Bound node",
        sinceOpenMs: 50,
        step: "first-render",
        durationMs: 12,
      },
    ]);
    expect(() => postFromWorkspaceRealm(7, timing, views, realmBindings)).not.toThrow();
    expect(() => postFromWorkspaceRealm(undefined, timing, views, realmBindings)).toThrow(
      "Only a workspace realm",
    );
    expect(() => postFromWorkspaceRealm(99, timing, views, realmBindings)).not.toThrow();
    realmBindings.delete("realm-42");
    expect(() => postFromWorkspaceRealm(42, timing, views, realmBindings)).not.toThrow();
    expect(post).not.toHaveBeenCalled();
    expect(views.msSinceOpened).toHaveBeenCalledTimes(1);
    postFromWorkspaceRealm(42, { type: "selection" }, views, realmBindings);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(42, { type: "selection" });
    expect(logs.records()).toHaveLength(1);
  } finally {
    logs.restore();
  }
});
