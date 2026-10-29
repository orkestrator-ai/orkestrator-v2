import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { useEnvironmentStore, useFilesPanelStore } from "@/stores";
import type { Environment } from "@/types";
import { DiffBaseDialog, defaultDiffBaseRef, saveDiffBase } from "./DiffBaseDialog";
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
  const tab = screen.getByRole("tab", { name: /Changes/ });
  expect(tab.getAttribute("data-state")).toBe("active");
  fireEvent.contextMenu(tab);
  expect(tab.getAttribute("data-state")).toBe("active");
  fireEvent.click(await screen.findByText("Compare against…"));
  expect(onChooseDiffBase).toHaveBeenCalledTimes(1);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function ready() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Compare" }).hasAttribute("disabled")).toBe(false),
  );
}

test("switching environments drops selections and ignores pending reads from the old checkout", async () => {
  const aCommits = deferred<typeof COMMITS>();
  const bBranches = deferred<typeof BRANCHES>();
  const bCommits = deferred<typeof COMMITS>();
  useEnvironmentStore.setState({ environments: [environment(), environment({ id: "env-2" })] });
  invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === "list_environment_diff_base_branches")
      return args?.environmentId === "env-1" ? Promise.resolve(BRANCHES) : bBranches.promise;
    if (command === "list_environment_diff_base_commits")
      return args?.environmentId === "env-1" ? aCommits.promise : bCommits.promise;
    throw new Error(`Unexpected command ${command}`);
  });
  const view = render(<DiffBaseDialog environmentId="env-1" open onOpenChange={() => undefined} />);
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("list_environment_diff_base_commits", {
      environmentId: "env-1",
      ref: BRANCHES[1]!.ref,
    }),
  );
  view.rerender(<DiffBaseDialog environmentId="env-2" open onOpenChange={() => undefined} />);
  await act(async () => {
    aCommits.resolve(COMMITS);
  });
  expect(screen.getByRole("button", { name: "Compare" }).hasAttribute("disabled")).toBe(true);
  await act(async () => {
    bBranches.resolve([BRANCHES[0]!]);
  });
  expect(screen.getByRole("button", { name: "Compare" }).hasAttribute("disabled")).toBe(true);
  await act(async () => {
    bCommits.resolve([COMMITS[1]!]);
  });
  await ready();
  expect(screen.getAllByRole("combobox")[0]!.textContent).toContain("feature");
  expect(screen.getAllByRole("combobox")[1]!.textContent).toContain("Older work");
});

test.each([true, false])(
  "reopening retains the stored commit (inside fetched window: %s)",
  async (inside) => {
    useEnvironmentStore.setState({
      environments: [
        environment({
          diffBaseOverride: { ref: BRANCHES[1]!.ref, commit: OLDER, subject: "Older work" },
        }),
      ],
    });
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) =>
      command === "list_environment_diff_base_commits"
        ? Promise.resolve(inside ? COMMITS : [COMMITS[0]!])
        : original(command, args),
    );
    render(<DiffBaseDialog environmentId="env-1" open onOpenChange={() => undefined} />);
    await ready();
    expect(screen.getAllByRole("combobox")[1]!.textContent).toContain("Older work");
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_environment_diff_base", {
        environmentId: "env-1",
        ref: BRANCHES[1]!.ref,
        commit: OLDER,
      }),
    );
  },
);

test("the picker can restore the automatic base", async () => {
  useEnvironmentStore.setState({
    environments: [environment({ diffBaseOverride: { ref: BRANCHES[1]!.ref, commit: OLDER } })],
  });
  const onOpenChange = mock(() => undefined);
  render(<DiffBaseDialog environmentId="env-1" open onOpenChange={onOpenChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Use automatic base" }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(useEnvironmentStore.getState().environments[0]!.diffBaseOverride).toBeNull();
});

test.each(["list_environment_diff_base_branches", "list_environment_diff_base_commits"])(
  "load errors disable Compare: %s",
  async (failedCommand) => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === failedCommand) throw new Error("Checkout unavailable");
      return BRANCHES;
    });
    render(<DiffBaseDialog environmentId="env-1" open onOpenChange={() => undefined} />);
    await screen.findByText("Checkout unavailable");
    expect(screen.getByRole("button", { name: "Compare" }).hasAttribute("disabled")).toBe(true);
  },
);

test("Reset and Change saves are serialized and superseded responses never replace local state", async () => {
  const resetResponse = deferred<Environment>();
  const changeResponse = deferred<Environment>();
  const initial = { ref: BRANCHES[1]!.ref, commit: OLDER };
  useEnvironmentStore.setState({ environments: [environment({ diffBaseOverride: initial })] });
  const saves: unknown[] = [];
  invokeMock.mockImplementation((_command: string, args?: Record<string, unknown>) => {
    saves.push(args);
    return args?.commit ? changeResponse.promise : resetResponse.promise;
  });
  const reset = saveDiffBase("env-1", null);
  await act(async () => {
    await Promise.resolve();
  });
  const change = saveDiffBase("env-1", { ref: BRANCHES[1]!.ref, commit: TIP });
  expect(saves).toHaveLength(1);
  // Even if the newer answer is ready first, its request waits for Reset.
  changeResponse.resolve(environment({ diffBaseOverride: { ref: BRANCHES[1]!.ref, commit: TIP } }));
  expect(useEnvironmentStore.getState().environments[0]!.diffBaseOverride).toEqual(initial);
  resetResponse.resolve(environment({ diffBaseOverride: null }));
  expect(await reset).toBe(true);
  expect(await change).toBe(true);
  expect(saves).toHaveLength(2);
  expect(useEnvironmentStore.getState().environments[0]!.diffBaseOverride?.commit).toBe(TIP);
});

test("a failed save releases the queue for the next choice", async () => {
  invokeMock.mockRejectedValueOnce(new Error("Offline"));
  expect(await saveDiffBase("env-1", null)).toBe(false);
  expect(await saveDiffBase("env-1", { ref: BRANCHES[1]!.ref, commit: TIP })).toBe(true);
  expect(useEnvironmentStore.getState().environments[0]!.diffBaseOverride?.commit).toBe(TIP);
});

test("switching branches disables Compare and ignores a late answer for the previous ref", async () => {
  const remote = deferred<typeof COMMITS>();
  const local = deferred<typeof COMMITS>();
  invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === "list_environment_diff_base_branches") return Promise.resolve(BRANCHES);
    if (command === "list_environment_diff_base_commits")
      return args?.ref === BRANCHES[0]!.ref ? local.promise : remote.promise;
    return Promise.resolve(
      environment({
        diffBaseOverride: { ref: args!.ref as string, commit: args!.commit as string },
      }),
    );
  });
  render(<DiffBaseDialog environmentId="env-1" open onOpenChange={() => undefined} />);
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("list_environment_diff_base_commits", {
      environmentId: "env-1",
      ref: BRANCHES[1]!.ref,
    }),
  );
  fireEvent.keyDown(screen.getAllByRole("combobox")[0]!, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "feature" }));
  await act(async () => {
    remote.resolve(COMMITS);
  });
  expect(screen.getByRole("button", { name: "Compare" }).hasAttribute("disabled")).toBe(true);
  await act(async () => {
    local.resolve([COMMITS[1]!]);
  });
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("set_environment_diff_base", {
      environmentId: "env-1",
      ref: BRANCHES[0]!.ref,
      commit: OLDER,
    }),
  );
});

test("an already selected commit cannot be submitted after switching the open picker to another environment", async () => {
  useEnvironmentStore.setState({ environments: [environment(), environment({ id: "env-2" })] });
  const onOpenChange = mock(() => undefined);
  const view = render(<DiffBaseDialog environmentId="env-1" open onOpenChange={onOpenChange} />);
  await ready();
  const branches = deferred<typeof BRANCHES>();
  const commits = deferred<typeof COMMITS>();
  invokeMock.mockImplementation((command: string) =>
    command === "list_environment_diff_base_branches" ? branches.promise : commits.promise,
  );
  view.rerender(<DiffBaseDialog environmentId="env-2" open onOpenChange={onOpenChange} />);
  const compare = screen.getByRole("button", { name: "Compare" });
  expect(compare.hasAttribute("disabled")).toBe(true);
  fireEvent.click(compare);
  expect(onOpenChange).not.toHaveBeenCalled();
  await act(async () => {
    branches.resolve(BRANCHES);
  });
  expect(compare.hasAttribute("disabled")).toBe(true);
  await act(async () => {
    commits.resolve([COMMITS[1]!]);
  });
  await ready();
  expect(screen.getAllByRole("combobox")[1]!.textContent).toContain("Older work");
});

test("a save finishing after an environment switch does not close the new picker", async () => {
  useEnvironmentStore.setState({ environments: [environment(), environment({ id: "env-2" })] });
  const response = deferred<Environment>();
  const original = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) =>
    command === "set_environment_diff_base" ? response.promise : original(command, args),
  );
  const onOpenChange = mock(() => undefined);
  const view = render(<DiffBaseDialog environmentId="env-1" open onOpenChange={onOpenChange} />);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  view.rerender(<DiffBaseDialog environmentId="env-2" open onOpenChange={onOpenChange} />);
  await act(async () => {
    response.resolve(environment({ diffBaseOverride: { ref: BRANCHES[1]!.ref, commit: TIP } }));
  });
  await ready();
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(
    useEnvironmentStore.getState().environments.find((item) => item.id === "env-2")
      ?.diffBaseOverride,
  ).toBeUndefined();
});
