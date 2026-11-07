import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
import { agentActivityStore } from "@/stores/agentActivityStore";
import { buildPipelineStore } from "@/stores/buildPipelineStore";
import { uiStore } from "@/stores/uiStore";
import type { Environment } from "@/types";
import { ProjectHomeActivity } from "./ProjectHomeActivity";
import { appCommandStore } from "@/test/app-command-store";

beforeEach(() => {
  appCommandStore(environmentStore).setState({
    environments: [],
    deletingEnvironments: new Set(),
    deletingStartedAt: new Map(),
  });
  appCommandStore(projectStore).setState({ deletingProjects: new Set() });
  appCommandStore(agentActivityStore).setState({
    containerStates: {},
    containerStateUpdatedAt: {},
  });
  appCommandStore(buildPipelineStore).setState({ activeBuildEnvironmentIds: new Set() });
  appCommandStore(uiStore).setState({ selectedProjectId: null, selectedEnvironmentId: null });
});
afterEach(cleanup);

test.each(["deletionError", "cleanupAfterMergeError"] as const)(
  "failed %s homes stay unavailable after a fresh store snapshot",
  (field) => {
    const home = {
      id: "home",
      projectId: "project",
      projectHome: true,
      environmentType: "local",
      status: "running",
      agentActivityState: "waiting",
      hasUnreadWork: true,
    } as Environment;
    appCommandStore(environmentStore).getState().setEnvironments([home]);
    const view = renderInAppCommandScope(<ProjectHomeActivity home={home} projectName="Project" />);
    fireEvent.click(screen.getByRole("button", { name: "Project Home needs attention" }));
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("home");
    const failed = { ...home, deletionRequestedAt: "2026-11-05T12:00:00Z", [field]: "failed" };
    act(() => {
      appCommandStore(uiStore).setState({ selectedEnvironmentId: null });
      appCommandStore(environmentStore).getState().setEnvironments([failed]);
    });
    view.rerender(<ProjectHomeActivity home={failed} projectName="Project" />);
    expect(screen.queryByRole("button", { name: /Project Home/ }) === null).toBe(true);
    view.unmount();
    renderInAppCommandScope(
      <ProjectHomeActivity
        home={{ ...failed, agentActivityState: "working" }}
        projectName="Project"
      />,
    );
    expect(screen.queryByRole("button", { name: /Project Home/ }) === null).toBe(true);
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBeNull();
  },
);
