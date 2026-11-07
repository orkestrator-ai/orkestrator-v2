import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useProjectStore } from "@/stores/projectStore";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useUIStore } from "@/stores/uiStore";
import type { Environment } from "@/types";
import { ProjectHomeActivity } from "./ProjectHomeActivity";

beforeEach(() => {
  useEnvironmentStore.setState({
    environments: [],
    deletingEnvironments: new Set(),
    deletingStartedAt: new Map(),
  });
  useProjectStore.setState({ deletingProjects: new Set() });
  useAgentActivityStore.setState({ containerStates: {}, containerStateUpdatedAt: {} });
  useBuildPipelineStore.setState({ activeBuildEnvironmentIds: new Set() });
  useUIStore.setState({ selectedProjectId: null, selectedEnvironmentId: null });
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
    useEnvironmentStore.getState().setEnvironments([home]);
    const view = renderInAppCommandScope(<ProjectHomeActivity home={home} projectName="Project" />);
    fireEvent.click(screen.getByRole("button", { name: "Project Home needs attention" }));
    expect(useUIStore.getState().selectedEnvironmentId).toBe("home");
    const failed = { ...home, deletionRequestedAt: "2026-11-05T12:00:00Z", [field]: "failed" };
    act(() => {
      useUIStore.setState({ selectedEnvironmentId: null });
      useEnvironmentStore.getState().setEnvironments([failed]);
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
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
  },
);
