import { useState } from "react";
import { useConversationScrollTarget } from "../../apps/web/src/components/native-agent/useConversationScrollTarget";
import { ProjectSearchBar } from "../../apps/web/src/components/sidebar/ProjectSearchBar";
import { usePaneLayoutStore } from "../../apps/web/src/stores/paneLayoutStore";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";
import { createSessionKey } from "../../apps/web/src/lib/utils";
import { environmentStore } from "../../apps/web/src/stores/environmentStore";
import { nativeAgentProjectionStore } from "../../apps/web/src/stores/nativeAgentProjectionStore";
import { paneLayoutStore } from "../../apps/web/src/stores/paneLayoutStore";
import { uiStore } from "../../apps/web/src/stores/uiStore";
import type { Environment, Project } from "../../apps/web/src/types";

/**
 * The ⌘K palette's History group over one running environment: an open
 * agent chat with loaded messages, a terminal, and two past conversations its
 * agent can resume. `?sessions=failed` makes the past-session list unreadable.
 */
const project: Project = {
  id: "project-1",
  name: "orkestrator-v2",
  gitUrl: "https://github.com/acme/orkestrator-v2.git",
  localPath: "/code/orkestrator-v2",
  addedAt: "2026-01-01T00:00:00.000Z",
  order: 0,
};

const environment: Environment = {
  id: "env-1",
  projectId: "project-1",
  name: "arm64-release",
  branch: "arm64-release",
  containerId: null,
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "local",
  worktreePath: "/code/arm64-release",
};

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const container: Environment = {
  ...environment,
  environmentType: "containerized",
  containerId: "fixture-container",
};
const messageIds = [{ id: "m-1" }, { id: "m-2" }];

function HistoryTranscript() {
  const isActive = usePaneLayoutStore(
    (state) => state.findPaneWithTab("tab-chat", environment.id)?.activeTabId === "tab-chat",
  );
  const highlight = useConversationScrollTarget({
    environmentId: environment.id,
    tabId: "tab-chat",
    isActive,
    messages: messageIds,
    transcriptSettled: true,
    scrollToIndex: (index) => {
      const row = document.getElementById(`fixture-message-${messageIds[index]?.id}`);
      if (!row) return false;
      row.scrollIntoView({ block: "center" });
      return true;
    },
  });
  return (
    <section className="mt-2 h-40 overflow-auto" aria-label="Fixture transcript" hidden={!isActive}>
      <div className="h-64" />
      {messageIds.map(({ id }) => (
        <p
          className="h-40"
          id={`fixture-message-${id}`}
          key={id}
          data-highlighted={highlight?.messageId === id}
        >
          Transcript message {id}
        </p>
      ))}
      <div className="h-64" />
    </section>
  );
}

function install(target: Environment) {
  const failed = new URLSearchParams(window.location.search).get("sessions") === "failed";
  window.orkestrator = {
    listen: () => () => {},
    invoke: async <T,>(command: string) => {
      if (command === "list_native_agent_resumable_sessions") {
        if (failed) throw new Error("bridge unavailable");
        return [
          { sessionId: "past-1", title: "Investigate the arm64 linker", updatedAt: hoursAgo(20) },
          { sessionId: "past-2", title: "Release checklist", updatedAt: hoursAgo(50) },
          { sessionId: "open-1", title: "Already open" },
        ] as T;
      }
      return null as T;
    },
  } as unknown as Window["orkestrator"];

  appCommandStore(environmentStore).setState({ environments: [target] });
  const layouts = appCommandStore(paneLayoutStore).getState();
  layouts.initialize(null, environment.id);
  const paneId = layouts.getActivePaneId(environment.id);
  layouts.addTab(
    paneId,
    {
      id: "tab-chat",
      type: "agent-native",
      displayTitle: "Fix the arm64 build",
      nativeAgentData: {
        platform: "codex",
        environmentId: environment.id,
        isLocal: true,
        sessionId: "open-1",
      },
    },
    environment.id,
  );
  layouts.addTab(
    paneId,
    { id: "tab-shell", type: "plain", displayTitle: "dev server" },
    environment.id,
  );
  layouts.finishHydration(environment.id, undefined);
  appCommandStore(nativeAgentProjectionStore)
    .getState()
    .setProjection(createSessionKey(environment.id, "tab-chat"), {
      platform: "codex",
      environmentId: environment.id,
      sessionId: "open-1",
      messages: [
        {
          id: "m-1",
          role: "user",
          content: "The arm64 build fails at link time on CI. Can you find out why?",
          parts: [],
          createdAt: hoursAgo(2),
        },
        {
          id: "m-2",
          role: "assistant",
          content:
            "The arm64 link step pulls in the x86_64 static library from the cache, so the linker rejects the archive. Clearing the per-architecture cache key fixes it.",
          parts: [],
          createdAt: hoursAgo(2),
        },
      ],
    } as never);
  appCommandStore(uiStore).getState().selectProjectAndEnvironment(project.id, environment.id);
  return true;
}

export function CommandPaletteHistoryFixture() {
  const [stops, setStops] = useState(0);
  const target = new URLSearchParams(window.location.search).has("power") ? container : environment;
  useState(() => install(target));
  return (
    <main className="max-w-sm">
      <ProjectSearchBar
        projects={[project]}
        environments={[target]}
        onSelectProject={() => {}}
        onSelectEnvironment={() => {}}
        commandHandlers={{
          startEnvironment: async () => {},
          stopEnvironment: async () => setStops((count) => count + 1),
        }}
      />
      {target === container ? (
        <output aria-label="Stop requests">{stops}</output>
      ) : (
        <HistoryTranscript />
      )}
    </main>
  );
}
