import { useState } from "react";
import { ActionBar } from "../../apps/web/src/components/layout/ActionBar";
import { TerminalProvider } from "../../apps/web/src/contexts/TerminalContext";
import { useEnvironmentStore, useProjectStore, useUIStore } from "../../apps/web/src/stores";
import type { Environment } from "../../apps/web/src/types";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";

const PROJECT_ID = "auto-merge-project";
const ENVIRONMENT_ID = "auto-merge-environment";

const MESSAGES = {
  short: "GitHub refused the merge",
  typical: "The pull request or merge effects changed; confirm the merge again",
  long: `GitHub refused the merge: ${"Required status check is expected and has not reported. ".repeat(30)}`,
};

/** The toolbar renders without its background answers, which stay pending. */
function installFixture(message: string) {
  delete window.orkestrator;
  window.orkestrator = {
    listen: () => () => {},
    invoke: <T,>() => new Promise<T>(() => {}),
  } as unknown as Window["orkestrator"];
  appCommandStore(useUIStore.def).setState({
    selectedProjectId: PROJECT_ID,
    selectedEnvironmentId: ENVIRONMENT_ID,
  });
  appCommandStore(useProjectStore.def).setState({
    projects: [
      {
        id: PROJECT_ID,
        name: "auto-merge-project",
        gitUrl: "",
        localPath: "/fixture/auto-merge-project",
        order: 0,
        addedAt: "2026-11-04T00:00:00.000Z",
      },
    ],
  });
  appCommandStore(useEnvironmentStore.def).setState({
    environments: [
      {
        id: ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        name: "auto-merge-environment",
        order: 0,
        environmentType: "local",
        status: "running",
        setupPhase: "ready",
        worktreePath: "/fixture/auto-merge-project/worktree",
        prUrl: "https://github.com/fixture/project/pull/7",
        prState: "open",
        hasMergeConflicts: false,
        autoMerge: true,
        autoMergeError: message,
        networkAccessMode: "restricted",
        createdAt: "2026-11-04T00:00:00.000Z",
      } as Environment,
    ],
  });
  return true;
}

/** `?message=short|typical|long` picks the failure, `?presentation=grid` the phone toolbar. */
export function AutoMergeErrorFixture() {
  const params = new URLSearchParams(window.location.search);
  const message = MESSAGES[(params.get("message") ?? "typical") as keyof typeof MESSAGES];
  useState(() => installFixture(message));
  return (
    <TerminalProvider>
      <div className="h-screen bg-background text-foreground">
        <ActionBar presentation={params.get("presentation") === "grid" ? "grid" : "bar"} />
      </div>
    </TerminalProvider>
  );
}
