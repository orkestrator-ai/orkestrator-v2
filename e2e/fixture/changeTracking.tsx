import { useState } from "react";
import {
  CHANGE_PROJECTION_CHANGED_EVENT,
  environmentChangeResourceKey,
} from "@orkestrator/protocol/change-resources";
import { ThreadChangesHeader } from "../../apps/web/src/components/changes/ThreadChangesHeader";
import { ChangeCountBadge } from "../../apps/web/src/components/changes/ChangeCountBadge";
import { DiffViewerTab } from "../../apps/web/src/components/terminal/DiffViewerTab";
import { FileViewerTab } from "../../apps/web/src/components/terminal/FileViewerTab";
import { useChangeProjectionStore } from "../../apps/web/src/stores/changeProjectionStore";
import { useToolChangePresentation } from "../../apps/web/src/hooks/useChangeProjection";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "../../apps/web/src/lib/native/events";

declare global {
  interface Window {
    changesInvoke?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
    changesReconnect?: () => void;
    changesInvalidate?: (generation: number) => void;
  }
}

export function installChangeTrackingFixture() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  window.orkestrator = {
    invoke: (command: string, args?: Record<string, unknown>) =>
      window.changesInvoke!(command, args ?? {}),
    listen: (event: string, callback: (payload: unknown) => void) => {
      const entries = listeners.get(event) ?? new Set();
      entries.add(callback);
      listeners.set(event, entries);
      return () => entries.delete(callback);
    },
  } as unknown as Window["orkestrator"];
  window.changesReconnect = () => {
    for (const listener of listeners.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT) ?? [])
      listener(undefined);
  };
  window.changesInvalidate = (generation) => {
    const resourceKey = environmentChangeResourceKey("env-1");
    const ownerGeneration = useChangeProjectionStore
      .getState()
      .projections.get(resourceKey)?.ownerGeneration;
    for (const listener of listeners.get(CHANGE_PROJECTION_CHANGED_EVENT) ?? []) {
      listener({
        kind: "content-invalidated",
        resourceKey,
        ownerGeneration,
        contentGeneration: generation,
        pathIds: null,
      });
    }
  };
}
const scope = { environmentId: "env-1", provider: "codex", conversationId: "s" };
const target = {
  kind: "live" as const,
  resourceKey: environmentChangeResourceKey("env-1"),
  path: "a.txt",
  title: "a.txt",
};
export function ChangeTrackingFixture() {
  const [active, setActive] = useState(true);
  const imagePath = new URLSearchParams(window.location.search).get("image");
  const { projections } = useToolChangePresentation(scope, "edit");
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <button onClick={() => setActive((value) => !value)}>
        {active ? "Switch away" : "Return"}
      </button>
      <ThreadChangesHeader environmentId="env-1" logicalSessionKey="tab" turnActive={false} />
      <div data-testid="fixture-tool-changes">
        {projections.map((item) =>
          item.projection ? (
            <ChangeCountBadge key={item.role} projection={item.projection} />
          ) : null,
        )}
      </div>
      <div
        className="relative min-h-0 flex-1"
        style={{ visibility: active ? "visible" : "hidden" }}
      >
        {imagePath ? (
          <FileViewerTab
            tabId="live-image"
            environmentId="env-1"
            filePath={imagePath}
            worktreePath="/fixture"
            isLocalEnvironment
            isActive={active}
            changeDiff={{ ...target, path: imagePath, title: imagePath }}
          />
        ) : (
          <DiffViewerTab target={target} isActive={active} />
        )}
      </div>
    </main>
  );
}
