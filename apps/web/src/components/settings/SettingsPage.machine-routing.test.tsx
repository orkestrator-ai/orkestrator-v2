import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { invoke } from "@/lib/native/backend";
import { portalStore } from "@/lib/portal/portal-store";
import { configStore } from "@/stores/configStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useAccountMachineStore } from "./account-machine";
import { SettingsPage } from "./SettingsPage";
import type { AppConfig } from "@/types";
import { appCommandStore } from "@/test/app-command-store";

const workspace = invoke as unknown as ReturnType<typeof mock>;
const initialConfig = appCommandStore(configStore).getState();
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
  if (command === "patch_global_config") {
    // As the backend does: merge onto the owner's own stored settings.
    const global = { ...configs[owner]!.global, ...(args.patch as object) } as Record<
      string,
      unknown
    >;
    for (const key of (args.unset as string[] | undefined) ?? []) delete global[key];
    writes.push({ owner, global: global as unknown as AppConfig["global"] });
    configs[owner] = { ...configs[owner]!, global: global as unknown as AppConfig["global"] };
    return configs[owner];
  }
  if (command === "get_backend_profile")
    return {
      revision: 1,
      displayName: owner === "command" ? "Command" : "Leaf",
      colorToken: "blue",
      updatedAt: "",
    };
  if (command === "get_node_status") return { nodeId: "command" };
  if (command === "get_node_summaries")
    return {
      selfId: "command",
      nodes,
      self: { nodeId: "command", displayName: "Command", projects: [], environments: [] },
    };
  if (command === "get_agent_model_catalog_cache") return { schemaVersion: 1 };
  if (command === "list_scheduled_jobs") return { schedules: [], timeZone: "Europe/London" };
  if (command === "get_log_directory") return `/${owner}/logs`;
  if (command === "get_github_cli_status")
    return { installed: false, authenticated: false, canSignIn: false };
  return undefined;
}
/** The command node's own answers, and another node's through `invoke_on_node`. */
async function commandNodeAnswer(command: string, args?: Record<string, unknown>) {
  return command === "invoke_on_node"
    ? {
        outcome: "ok",
        result: answer(
          String(args?.nodeId),
          String(args?.command),
          args?.args as Record<string, unknown>,
        ),
      }
    : answer("command", command, args);
}
beforeEach(() => {
  writes.length = 0;
  configs = Object.fromEntries(["command", "leaf", "other"].map((owner) => [owner, config(owner)]));
  // The command node's own window: its command scope is the window's.
  workspace.mockImplementation(commandNodeAnswer);
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
  portalStore.store.setState(initialPortal);
  appCommandStore(configStore).setState(initialConfig);
  useRemoteWorkspaceStore.setState(initialRemote);
  useAccountMachineStore.getState().choose(undefined);
  workspace.mockReset();
});
function mount(section: "general" | "version-control" | "review" | "experimental" = "general") {
  return renderInAppCommandScope(
    <FederationProvider>
      <SettingsPage open onOpenChange={() => {}} defaultSection={section} />
    </FederationProvider>,
  );
}

test("a command window with a leaf selected only offers scheduling on the window machine", async () => {
  mount("experimental");
  await screen.findByText(/Experimental settings belong to the machine this window runs on/);
  expect(screen.queryByRole("switch", { name: "Enable scheduling" }) === null).toBe(true);
  expect(screen.queryAllByRole("button", { name: "Schedules" })).toHaveLength(0);
  expect(writes).toEqual([]);

  fireEvent.click((await screen.findAllByRole("button", { name: /^Command/ }))[0]!);
  const toggle = await screen.findByRole("switch", { name: "Enable scheduling" });
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(writes).toContainEqual(
      expect.objectContaining({
        owner: "command",
        global: expect.objectContaining({ experimentalScheduling: true }),
      }),
    ),
  );
  expect(writes.some((write) => write.owner === "leaf")).toBe(false);
  expect(configs.leaf!.global.experimentalScheduling).not.toBe(true);
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Schedules" }).length).toBeGreaterThan(0),
  );
  fireEvent.click(screen.getAllByRole("button", { name: /^Leaf/ })[0]!);
  await screen.findByText(/Experimental settings belong to the machine this window runs on/);
  expect(screen.queryByRole("switch", { name: "Enable scheduling" }) === null).toBe(true);
  fireEvent.click(screen.getAllByRole("button", { name: "Schedules" })[0]!);
  await waitFor(() =>
    expect(workspace.mock.calls.some(([command]) => command === "list_scheduled_jobs")).toBe(true),
  );
  expect(
    workspace.mock.calls.some(
      ([command, args]) => command === "invoke_on_node" && args?.command === "list_scheduled_jobs",
    ),
  ).toBe(false);
});

test("the Self-improvement tab exists only while its experimental switch is on, off by default", async () => {
  mount("experimental");
  await screen.findByText(/Experimental settings belong to the machine this window runs on/);
  fireEvent.click((await screen.findAllByRole("button", { name: /^Command/ }))[0]!);
  const toggle = await screen.findByRole("switch", { name: "Enable self-improvement" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(screen.queryAllByRole("button", { name: "Self-improvement" })).toHaveLength(0);

  fireEvent.click(toggle);
  await waitFor(() =>
    expect(writes).toContainEqual(
      expect.objectContaining({
        owner: "command",
        global: expect.objectContaining({ experimentalSelfImprovement: true }),
      }),
    ),
  );
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Self-improvement" }).length).toBeGreaterThan(0),
  );
});
