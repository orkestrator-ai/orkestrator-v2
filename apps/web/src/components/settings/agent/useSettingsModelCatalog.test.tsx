import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  cleanupNodeScopes,
  FakeNodeClient,
  renderHookInAppCommandScope,
  renderInNodeScope,
} from "@/test/render-in-node-scope";
import type { BackendId } from "@orkestrator/protocol/federation";
import { CreateEnvironmentDialog } from "@/components/environments/CreateEnvironmentDialog";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { configStore } from "@/stores/configStore";
import type { ReactNode } from "react";
import * as machineViews from "@/components/federation/useMachineViews";
import * as federation from "@/components/federation/FederationProvider";
import { invoke } from "@/lib/native/backend";
import { portalStore } from "@/lib/portal/portal-store";
import { agentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import { projectStore, uiStore } from "@/stores";
import { getAppVersion } from "@/lib/backend";
import { AccountMachineProvider } from "../account-machine";
import { useSettingsModelCatalog } from "./useSettingsModelCatalog";
import { appCommandStore } from "@/test/app-command-store";

const workspace = invoke as unknown as ReturnType<typeof mock>;
const initialModels = appCommandStore(agentModelCatalogStore).getState();
const initialProjects = appCommandStore(projectStore).getState();
const initialUI = appCommandStore(uiStore).getState();
const initialPortal = portalStore.getState();
afterEach(() => {
  cleanup();
  cleanupNodeScopes();
  mock.restore();
  workspace.mockReset();
  appCommandStore(agentModelCatalogStore).setState(initialModels);
  appCommandStore(projectStore).setState(initialProjects);
  appCommandStore(uiStore).setState(initialUI);
  portalStore.store.setState(initialPortal);
});
{
  const machine = "other";
  test("another machine's catalogue reads and refresh use its projects and preserve workspace models", async () => {
    portalStore.store.setState({ selfId: "command" as never });
    appCommandStore(agentModelCatalogStore).setState({
      codexModels: [
        { id: "leaf-model", name: "Leaf model", description: "", reasoningEfforts: [] },
      ],
    });
    appCommandStore(projectStore).setState({
      projects: [{ id: "leaf-project", name: "Leaf project" }] as never,
    });
    appCommandStore(uiStore).setState({ selectedProjectId: "leaf-project" });
    const owner = machine;
    const project = { ref: { projectId: `${owner}-project` }, name: `${owner} project` };
    spyOn(federation, "useFederation").mockReturnValue({
      portalState: {
        selfId: "command",
        self: { projects: [project] },
        nodes: [{ nodeId: "other", projects: [project] }],
      },
    } as never);
    spyOn(machineViews, "useRemoteMachineView").mockReturnValue(null);
    let revision = 1;
    const reads: Array<{ owner: string; command: string; args: Record<string, unknown> }> = [];
    const response = (target: string, command: string, args: Record<string, unknown> = {}) => {
      reads.push({ owner: target, command, args });
      if (command === "get_agent_model_catalog_cache")
        return {
          schemaVersion: 1,
          codex: {
            models: [
              {
                id: `${target}-model-${revision}`,
                name: target,
                description: "",
                reasoningEfforts: ["high"],
              },
            ],
          },
        };
      if (command === "get_opencode_model_catalog_cache")
        return {
          projectId: args.projectId,
          models: [{ id: `${target}/model-${revision}`, name: target, provider: target }],
        };
      if (command === "refresh_host_agent_model_catalog") {
        revision += 1;
        return { agent: args.agent, modelCount: 1 };
      }
      if (command === "get_app_version") return target === "other" ? "3.0.0" : "2.0.0";
      throw new Error(`Unexpected command: ${command}`);
    };
    // The command node's own window: its own answers, another node's through it.
    workspace.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "invoke_on_node"
        ? {
            outcome: "ok",
            result: response(
              String(args?.nodeId),
              String(args?.command),
              args?.args as Record<string, unknown>,
            ),
          }
        : response("command", command, args),
    );
    const leaf = new FakeNodeClient({ nodeId: owner as BackendId })
      .respond("get_agent_model_catalog_cache", () => ({
        schemaVersion: 1,
        codex: {
          updatedAt: new Date(revision * 1000).toISOString(),
          models: [{ id: `other-model-${revision}`, name: `Studio Codex ${revision}` }],
        },
      }))
      .respond("get_opencode_model_catalog_cache", null);
    const dialog = renderInNodeScope(<></>, { client: leaf, role: "leaf" });
    const config = appCommandStore(configStore).getState().config;
    dialog.scope.store(configStore).setState({
      config: { ...config, global: { ...config.global, enabledAgentPlatforms: ["codex"] } },
    });
    dialog.rerender(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentDialog
          open
          projectId="other-project"
          onOpenChange={() => {}}
          onCreate={async () => true}
        />
      </DockerAvailabilityProvider>,
    );
    await waitFor(() =>
      expect(dialog.scope.store(agentModelCatalogStore).getState().codexModels[0]?.id).toBe(
        "other-model-1",
      ),
    );
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Agent, model and reasoning" }));
    const modelMenu = () => within(screen.getByRole("group", { name: "Models", hidden: true }));
    expect(
      modelMenu().getByRole("menuitemradio", { name: /Studio Codex 1/, hidden: true }),
    ).toBeTruthy();

    const wrapper = ({ children }: { children: ReactNode }) => (
      <AccountMachineProvider value={{ machine, name: owner }}>{children}</AccountMachineProvider>
    );
    const { result } = renderHookInAppCommandScope(useSettingsModelCatalog, { wrapper });
    await waitFor(() => expect(result.current.catalog.codex[0]?.id).toBe(`${owner}-model-1`));
    expect(result.current.catalogProjectId).toBe(`${owner}-project`);
    expect(result.current.selectedProjectId).toBeNull();
    expect(result.current.catalog.opencode[0]?.id).toBe(`${owner}/model-1`);
    await act(async () => {
      await result.current.refresh("opencode");
    });
    expect(reads).toContainEqual({
      owner,
      command: "refresh_host_agent_model_catalog",
      args: { agent: "opencode", projectId: `${owner}-project` },
    });
    expect(result.current.catalog.opencode[0]?.id).toBe(`${owner}/model-2`);
    await act(async () => {
      await result.current.refresh("codex");
    });
    expect(result.current.catalog.codex[0]?.id).toBe(`${owner}-model-3`);
    await waitFor(() =>
      expect(
        modelMenu().getByRole("menuitemradio", { name: /Studio Codex 3/, hidden: true }),
      ).toBeTruthy(),
    );
    expect(appCommandStore(agentModelCatalogStore).getState().codexModels[0]?.id).toBe(
      "leaf-model",
    );
    // All of the remote Settings catalogue calls went through the node proxy.
    expect(workspace.mock.calls.filter(([command]) => command.includes("model_catalog"))).toEqual(
      [],
    );
    expect(await getAppVersion(machine)).toBe("3.0.0");
    expect(await getAppVersion()).toBe("2.0.0");
  });
}
