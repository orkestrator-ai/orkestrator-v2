import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { useEnvironmentStore, useFilesPanelStore } from "@/stores";
import type { Environment } from "@/types";
import { DiffBaseDialog, defaultDiffBaseRef } from "./DiffBaseDialog";
import { DiffBaseNotice } from "./DiffBaseNotice";
import { FilesPanelHeader } from "./FilesPanelHeader";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
const TIP = "a".repeat(40);
const OLDER = "b".repeat(40);
const BRANCHES = [
  { ref: "refs/heads/feature", name: "feature", kind: "local" },
  { ref: "refs/remotes/origin/main", name: "origin/main", kind: "remote" },
];
const COMMITS = [
  { commit: TIP, subject: "Merge pull request #12", author: "Ada", committedAt: "" },
  { commit: OLDER, subject: "Older work", author: "Ada", committedAt: "" },
];

function environment(overrides: Partial<Environment> = {}): Environment {
  return { id: "env-1", projectId: "project-1", ...overrides } as Environment;
}

beforeEach(() => {
  useEnvironmentStore.setState({ environments: [environment()] });
  useFilesPanelStore.setState({ activeTab: "changes", changes: [] });
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "list_environment_diff_base_branches") return BRANCHES;
    if (command === "list_environment_diff_base_commits") return COMMITS;
    if (command === "set_environment_diff_base") {
      return environment({
        diffBaseOverride: args?.commit
          ? { ref: args.ref as string, commit: args.commit as string, subject: "Merge" }
          : null,
      });
    }
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

test("the target branch's remote copy is preselected, then the current choice", () => {
  const branches = BRANCHES as Parameters<typeof defaultDiffBaseRef>[0];
  expect(defaultDiffBaseRef(branches, {}, { defaultBranch: "main" })).toBe(
    "refs/remotes/origin/main",
  );
  expect(
    defaultDiffBaseRef(
      branches,
      { diffBaseOverride: { ref: "refs/heads/feature", commit: TIP } },
      null,
    ),
  ).toBe("refs/heads/feature");
  expect(defaultDiffBaseRef(branches, { prBaseBranch: "release" }, null)).toBe(
    "refs/heads/feature",
  );
});

test("comparing against the tip of the target branch saves that commit", async () => {
  const onOpenChange = mock(() => undefined);
  render(<DiffBaseDialog environmentId="env-1" open onOpenChange={onOpenChange} />);

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("list_environment_diff_base_commits", {
      environmentId: "env-1",
      ref: "refs/remotes/origin/main",
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Compare" }).hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));

  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(invokeMock).toHaveBeenCalledWith("set_environment_diff_base", {
    environmentId: "env-1",
    ref: "refs/remotes/origin/main",
    commit: TIP,
  });
  expect(useEnvironmentStore.getState().environments[0]!.diffBaseOverride?.commit).toBe(TIP);
});

test("the notice names the chosen base and resets it", async () => {
  useEnvironmentStore.setState({
    environments: [
      environment({
        diffBaseOverride: { ref: "refs/remotes/origin/main", commit: TIP, subject: "Merge #12" },
      }),
    ],
  });
  render(<DiffBaseNotice environmentId="env-1" onChange={() => undefined} />);
  expect(screen.getByTestId("diff-base-notice").textContent).toContain("origin/main");
  expect(screen.getByTestId("diff-base-notice").textContent).toContain("Merge #12");

  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  await waitFor(() => expect(screen.queryByTestId("diff-base-notice")).toBeNull());
  expect(invokeMock).toHaveBeenCalledWith("set_environment_diff_base", {
    environmentId: "env-1",
    ref: null,
    commit: null,
  });
});

test("right-clicking the Changes tab offers the comparison picker", async () => {
  const onChooseDiffBase = mock(() => undefined);
  render(
    <FilesPanelHeader
      onRefresh={() => undefined}
      changeEnvironmentId="env-1"
      onChooseDiffBase={onChooseDiffBase}
    />,
  );
  fireEvent.contextMenu(screen.getByRole("tab", { name: /Changes/ }));
  fireEvent.click(await screen.findByText("Compare against…"));
  expect(onChooseDiffBase).toHaveBeenCalledTimes(1);
});
