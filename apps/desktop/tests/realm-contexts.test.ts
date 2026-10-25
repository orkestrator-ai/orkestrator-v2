import { expect, mock, test } from "bun:test";
import { RealmContexts, refreshWorkspaceRealm } from "../electron/realm-contexts";
import type { WorkspaceContext } from "../electron/window-workspace-target";
import { exposeActiveConnectionGateway } from "../electron/preload-api";

function context(id: number, parentId: number, events: string[]) {
  return {
    contents: { id, isDestroyed: () => false, isFocused: () => true },
    realm: { parentWebContentsId: parentId, viewId: `view-${id}` },
    browserPreviewManager: { destroyAll: () => void events.push("previews") },
    artifactHosts: { dispose: () => void events.push("artifacts") },
    previewTransport: {
      disposeAll: async () => {
        events.push("transports");
      },
    },
  };
}

test("realm contexts register and dispose resources once before scope release", () => {
  const events: string[] = [];
  const contexts = new RealmContexts<ReturnType<typeof context>>(
    (id) => {
      expect(contexts.get(id)).toBeUndefined();
      events.push("prompts");
    },
    () => {
      throw new Error("unexpected disposal failure");
    },
  );
  const realm = context(10, 1, events);
  contexts.register(realm);
  expect(contexts.get(10) === realm).toBe(true);
  expect(Array.from(contexts.values())).toHaveLength(1);
  contexts.unregister(10);
  // WorkspaceViews releases the scope after unregister returns.
  events.push("scope");
  contexts.unregister(10);
  expect(events).toEqual(["previews", "artifacts", "transports", "prompts", "scope"]);
  expect(Array.from(contexts.values())).toHaveLength(0);
});

test("menu-close-tab routes to the focused live realm of its owning window", () => {
  const contexts = new RealmContexts<ReturnType<typeof context>>(
    () => undefined,
    () => undefined,
  );
  const otherWindow = context(10, 2, []);
  const dead = context(11, 1, []);
  dead.contents.isDestroyed = () => true;
  const hidden = context(12, 1, []);
  hidden.contents.isFocused = () => false;
  const focused = context(13, 1, []);
  for (const realm of [otherWindow, dead, hidden, focused]) contexts.register(realm);
  const emit = mock((_id: number, _event: string) => undefined);
  emit(contexts.focused(1)?.contents.id ?? 1, "menu-close-tab");
  expect(emit).toHaveBeenLastCalledWith(13, "menu-close-tab");
  contexts.unregister(13);
  emit(contexts.focused(1)?.contents.id ?? 1, "menu-close-tab");
  expect(emit).toHaveBeenLastCalledWith(1, "menu-close-tab");
});

test("transport disposal rejection is handled after the realm is removed", async () => {
  const report = mock((_error: unknown) => undefined);
  const contexts = new RealmContexts<ReturnType<typeof context>>(() => undefined, report);
  const realm = context(10, 1, []);
  const error = new Error("transport failed");
  realm.previewTransport.disposeAll = async () => {
    throw error;
  };
  contexts.register(realm);
  contexts.unregister(10);
  await Promise.resolve();
  expect(report).toHaveBeenCalledWith(error);
  expect(contexts.get(10)).toBeUndefined();
});

test("route refresh updates registered snapshots before reload and recreates old-origin previews", async () => {
  const events: string[] = [];
  const target: WorkspaceContext["target"] = {
    nodeId: "bk_leaf",
    nodeName: "Leaf",
    path: "relay",
    via: "Command",
  };
  const next: WorkspaceContext["target"] = {
    nodeId: "bk_leaf",
    nodeName: "Leaf",
    path: "direct",
    routeKind: "https",
  };
  const contexts = new RealmContexts<
    ReturnType<typeof context> & {
      target: WorkspaceContext["target"];
      previewConnectionId: string;
      contents: ReturnType<typeof context>["contents"] & { reload(): void };
    }
  >(
    () => undefined,
    () => undefined,
  );
  const replacement = {
    manager: { destroyAll: () => void events.push("new-previews") },
    previewTransport: {
      disposeAll: async () => {
        events.push("new-transports");
      },
    },
  };
  const realm = {
    ...context(10, 1, events),
    target,
    previewConnectionId: "workspace:old",
    contents: {
      ...context(10, 1, events).contents,
      reload: () => {
        events.push("reload");
        expect(contexts.get(10)?.target).toEqual(next);
        expect(realm.browserPreviewManager).toBe(replacement.manager);
        // The new document's preload reads its authoritative IPC snapshot.
        const exposed = new Map<string, unknown>();
        exposeActiveConnectionGateway(
          {
            exposeInMainWorld: (key, value) => {
              exposed.set(key, value);
            },
          },
          {
            sendSync: (channel) =>
              channel.endsWith("gateway-sync")
                ? {
                    baseUrl: "https://leaf.test",
                    connectionId: "workspace:old",
                    backendId: "bk_leaf",
                    legacyOrigin: null,
                    workspaceTarget: contexts.get(10)?.target,
                  }
                : { connections: [] },
          },
        );
        expect(exposed.get("orkestratorWorkspaceTarget")).toEqual(next);
        expect(exposed.get("orkestratorGateway")).toMatchObject({ baseUrl: "https://leaf.test" });
      },
    },
  };
  contexts.register(realm);
  refreshWorkspaceRealm(realm, next, (id) => {
    expect(id).toBe("workspace:old");
    return replacement;
  });
  expect(events).toEqual(["previews", "transports", "reload"]);
  expect(contexts.get(10)?.target).toEqual(next);
  contexts.unregister(10);
  await Promise.resolve();
});
