import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { invoke } from "@/lib/native/backend";
import { portalStore } from "@/lib/portal/portal-store";
import { useConfigStore } from "@/stores/configStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useAccountMachineStore } from "./account-machine";
import { SettingsPage } from "./SettingsPage";
import type { AppConfig } from "@/types";

const workspace = invoke as unknown as ReturnType<typeof mock>;
const initialConfig = useConfigStore.getState();
const initialPortal = portalStore.getState();
const initialRemote = useRemoteWorkspaceStore.getState();
let configs: Record<string, AppConfig>;
const writes: Array<{ owner: string; global: AppConfig["global"] }> = [];
function config(owner: string): AppConfig {
  const base = structuredClone(initialConfig.config);
  return {
    ...base,
    repositories: { [owner]: { defaultBranch: "main", prBaseBranch: "main" } },
    global: {
      ...base.global,
      defaultProjectsDirectory: `/${owner}/projects`,
      allowedDomains: [`${owner}.test`],
      enabledAgentPlatforms: [owner === "command" ? "codex" : "claude"],
      useHostGitHubCredentials: false,
    },
  };
}
const nodes = ["leaf", "other"].map((nodeId) => ({
  nodeId,
  view: { displayName: nodeId === "leaf" ? "Leaf" : "Other", connection: { state: "connected" } },
  projects: [],
  environments: [],
  freshness: "current",
}));
function answer(owner: string, command: string, args: Record<string, unknown> = {}): unknown {
  if (command === "get_config") return configs[owner];
  if (command === "update_global_config") {
    writes.push({ owner, global: args.global as AppConfig["global"] });
    configs[owner] = { ...configs[owner]!, global: args.global as AppConfig["global"] };
    return configs[owner];
  }
  if (command === "get_backend_profile")
    return { revision: 1, displayName: "Leaf", colorToken: "blue", updatedAt: "" };
  if (command === "get_node_status") return { nodeId: "command" };
  if (command === "get_node_summaries")
    return {
      selfId: "command",
      nodes,
      self: { nodeId: "command", displayName: "Command", projects: [], environments: [] },
    };
  if (command === "get_agent_model_catalog_cache") return { schemaVersion: 1 };
  if (command === "get_log_directory") return `/${owner}/logs`;
  if (command === "get_github_cli_status")
    return { installed: false, authenticated: false, canSignIn: false };
  return undefined;
}
beforeEach(() => {
  writes.length = 0;
  configs = Object.fromEntries(["command", "leaf", "other"].map((owner) => [owner, config(owner)]));
  workspace.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
    answer("leaf", command, args),
  );
  window.orkestratorWorkspaceTarget = { nodeId: "leaf", nodeName: "Leaf", path: "direct" };
  window.orkestratorPortal = {
    invoke: mock(async (command: string, args?: Record<string, unknown>) =>
      command === "invoke_on_node"
        ? {
            outcome: "ok",
            result: answer(
              String(args?.nodeId),
              String(args?.command),
              args?.args as Record<string, unknown>,
            ),
          }
        : answer("command", command, args),
    ),
    listen: () => () => {},
  } as never;
  portalStore.store.setState({
    ...initialPortal,
    selfId: "command" as never,
    nodes: nodes as never,
  });
  useRemoteWorkspaceStore.setState({
    active: { nodeId: "leaf", projectId: null, environmentId: null },
  });
  useAccountMachineStore.getState().choose(undefined);
});
afterEach(() => {
  cleanup();
  delete window.orkestratorPortal;
  delete window.orkestratorWorkspaceTarget;
  portalStore.store.setState(initialPortal);
  useConfigStore.setState(initialConfig);
  useRemoteWorkspaceStore.setState(initialRemote);
  useAccountMachineStore.getState().choose(undefined);
  workspace.mockReset();
});
function mount(section: "general" | "review" = "general") {
  return render(
    <FederationProvider>
      <SettingsPage open onOpenChange={() => {}} defaultSection={section} />
    </FederationProvider>,
  );
}
async function directory(path: string) {
  await waitFor(() =>
    expect((screen.getByLabelText("Default projects folder") as HTMLInputElement).value).toBe(path),
  );
}

test("leaf window selects command, bound leaf and another leaf without mixing config or folder pickers", async () => {
  mount();
  await directory("/leaf/projects");
  expect(
    (screen.getByLabelText("Browse for the default projects folder") as HTMLButtonElement).disabled,
  ).toBe(false);
  fireEvent.click(screen.getAllByRole("button", { name: /^Command/ })[0]!);
  await directory("/command/projects");
  for (const label of ["Browse for the default projects folder", "Browse for SSH agent socket"])
    expect((screen.getByLabelText(label) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Default projects folder"), {
    target: { value: "/command/changed" },
  });
  await waitFor(() => expect(writes.some((write) => write.owner === "command")).toBe(true));
  expect(writes.find((write) => write.owner === "command")?.global).toMatchObject({
    defaultProjectsDirectory: "/command/changed",
    allowedDomains: ["command.test"],
    enabledAgentPlatforms: ["codex"],
  });
  await waitFor(() =>
    expect(useConfigStore.getState().config.repositories).toEqual({
      leaf: { defaultBranch: "main", prBaseBranch: "main" },
    }),
  );
  expect(useConfigStore.getState().config.global).toMatchObject({
    defaultProjectsDirectory: "/leaf/projects",
    allowedDomains: ["leaf.test"],
    enabledAgentPlatforms: ["claude"],
  });
  fireEvent.click(screen.getAllByRole("button", { name: /^Other/ })[0]!);
  await directory("/other/projects");
  expect(
    (screen.getByLabelText("Browse for the default projects folder") as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getAllByRole("button", { name: /^Leaf/ })[0]!);
  await directory("/leaf/projects");
  expect((screen.getByLabelText("Browse for SSH agent socket") as HTMLButtonElement).disabled).toBe(
    false,
  );
});

test("locked command-node section saves independently loaded command config", async () => {
  mount("review");
  const field = await screen.findByLabelText("Review instruction");
  fireEvent.change(field, { target: { value: "Review with care" } });
  await waitFor(() => expect(writes.some((write) => write.owner === "command")).toBe(true));
  expect(writes[0]).toMatchObject({
    owner: "command",
    global: {
      allowedDomains: ["command.test"],
      defaultProjectsDirectory: "/command/projects",
      reviewInstruction: "Review with care",
    },
  });
  expect(writes.some((write) => write.owner === "leaf")).toBe(false);
  await act(async () => {});
});

test("the Schedules section is offered only while experimental scheduling is on", async () => {
  const view = mount();
  await directory("/leaf/projects");
  expect(screen.queryAllByRole("button", { name: "Schedules" })).toHaveLength(0);
  expect(screen.getAllByRole("button", { name: "Experimental" }).length).toBeGreaterThan(0);
  view.unmount();

  configs.leaf = {
    ...configs.leaf!,
    global: { ...configs.leaf!.global, experimentalScheduling: true },
  };
  useConfigStore.setState(initialConfig);
  mount();
  await directory("/leaf/projects");
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Schedules" }).length).toBeGreaterThan(0),
  );
});
