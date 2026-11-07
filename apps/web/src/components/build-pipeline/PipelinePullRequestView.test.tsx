import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { invoke } from "@/lib/native/backend";
import { environmentStore } from "@/stores/environmentStore";
import { filesPanelStore } from "@/stores/filesPanelStore";
import { uiStore } from "@/stores/uiStore";
import type { Environment } from "@/types";
import {
  PipelinePullRequestChecks,
  PipelinePullRequestView,
  pipelineCheckState,
  pipelineCheckSummary,
} from "./PipelinePullRequestView";
import { setFilesPanelTestState } from "@/test/files-panel-state";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import { appCommandStore } from "@/test/app-command-store";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  appCommandStore(uiStore).setState({ selectedProjectId: null, selectedEnvironmentId: null });
  appCommandStore(environmentStore).setState({ environments: [] });
  setFilesPanelTestState({ isOpen: false, activeTab: "changes", pullRequestTabs: {} });
});

function renderShippedPullRequest() {
  const url = "https://github.com/acme/app/pull/1";
  appCommandStore(environmentStore).setState({
    environments: [{ id: "pipeline-env", projectId: "project-1", prUrl: url } as Environment],
  });
  appCommandStore(uiStore).setState({
    selectedProjectId: "project-1",
    selectedEnvironmentId: "pipeline-env",
  });
  renderInAppCommandScope(
    <PipelinePullRequestView
      environmentId="pipeline-env"
      shipped
      pullRequest={{ url, state: "open", checks: null }}
    />,
  );
  return url;
}

test.each([
  ["the link", () => screen.getByRole("link")],
  ["View PR", () => screen.getByRole("button", { name: "View PR" })],
])("%s opens the pull request in the right-hand PR pane", async (_, target) => {
  invokeMock.mockClear();
  renderShippedPullRequest();
  fireEvent.click(target());
  await waitFor(() => expect(useFilesPanelChromeStore.getState().isOpen).toBe(true));
  expect(
    appCommandStore(filesPanelStore).getState().pullRequestTabs["pipeline-env"]?.[0]?.ref,
  ).toEqual({
    owner: "acme",
    repo: "app",
    number: 1,
  });
  expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("pipeline-env");
  expect(invokeMock).not.toHaveBeenCalledWith("open_in_browser", expect.anything());
});

test.each([
  ["Open on GitHub", () => fireEvent.click(screen.getByRole("button", { name: "Open on GitHub" }))],
  ["a Cmd-click on the link", () => fireEvent.click(screen.getByRole("link"), { metaKey: true })],
])("%s still opens the browser", async (_, act) => {
  invokeMock.mockClear();
  const url = renderShippedPullRequest();
  act();
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("open_in_browser", { url }));
  expect(useFilesPanelChromeStore.getState().isOpen).toBe(false);
});

test("failed checks take precedence over simultaneous pending checks", () => {
  const checks = { total: 4, passed: 2, pending: 1 };
  expect(pipelineCheckState(checks)).toBe("failing");
  expect(pipelineCheckSummary(checks)).toBe("2 of 4 checks passed · 1 failing · 1 pending");
  const { container } = renderInAppCommandScope(<PipelinePullRequestChecks checks={checks} />);
  expect(container.querySelector('[data-pr-checks="failing"]')?.textContent).toContain(
    "CI failing",
  );
});

test("zero checks and unknown checks have explicit labels", () => {
  const { rerender, container } = renderInAppCommandScope(
    <PipelinePullRequestChecks checks={{ total: 0, passed: 0, pending: 0 }} />,
  );
  expect(screen.getByText("No CI checks")).toBeTruthy();
  expect(container.querySelector("[data-pr-checks]") === null).toBe(true);
  expect(pipelineCheckSummary({ total: 0, passed: 0, pending: 0 })).toBe("No CI checks reported");
  rerender(<PipelinePullRequestChecks checks={null} />);
  expect(screen.getByText("CI status not known yet")).toBeTruthy();
});

test.each(["merged", "closed"] as const)("labels a %s PR alongside its CI summary", (state) => {
  renderInAppCommandScope(
    <PipelinePullRequestView
      environmentId="test-pr-environment"
      shipped
      pullRequest={{
        url: "https://github.com/acme/app/pull/1",
        state,
        checks: { total: 4, passed: 2, pending: 1 },
      }}
    />,
  );
  expect(screen.getByTestId("pipeline-pr-state").textContent).toBe(
    state === "merged" ? "Merged" : "Closed",
  );
  expect(screen.getByTestId("pipeline-pr-checks").textContent).toContain("1 failing · 1 pending");
});
