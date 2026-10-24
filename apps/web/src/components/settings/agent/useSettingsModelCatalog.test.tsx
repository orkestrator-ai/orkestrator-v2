import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import * as federation from "@/components/federation/FederationProvider";
import { invoke } from "@/lib/native/backend";
import { portalStore } from "@/lib/portal/portal-store";
import { useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import { useProjectStore, useUIStore } from "@/stores";
import { getAppVersion } from "@/lib/backend";
import { AccountMachineProvider } from "../account-machine";
import { useSettingsModelCatalog } from "./useSettingsModelCatalog";

const workspace = invoke as unknown as ReturnType<typeof mock>;
const initialModels = useAgentModelCatalogStore.getState();
const initialProjects = useProjectStore.getState();
const initialUI = useUIStore.getState();
const initialPortal = portalStore.getState();
afterEach(() => {
  cleanup();
  mock.restore();
  workspace.mockReset();
  useAgentModelCatalogStore.setState(initialModels);
  useProjectStore.setState(initialProjects);
  useUIStore.setState(initialUI);
  portalStore.store.setState(initialPortal);
  delete window.orkestratorPortal;
  delete window.orkestratorWorkspaceTarget;
});
for (const machine of [null, "other"]) {
  test(`catalogue reads and refresh use ${machine ?? "command node"} projects and preserve workspace models`, async () => {
    window.orkestratorWorkspaceTarget = { nodeId: "leaf", nodeName: "Leaf", path: "direct" };
    portalStore.store.setState({ selfId: "command" as never });
    useAgentModelCatalogStore.setState({
      codexModels: [
        { id: "leaf-model", name: "Leaf model", description: "", reasoningEfforts: [] },
      ],
    });
    useProjectStore.setState({ projects: [{ id: "leaf-project", name: "Leaf project" }] as never });
    useUIStore.setState({ selectedProjectId: "leaf-project" });
    const owner = machine ?? "command";
    const project = { ref: { projectId: `${owner}-project` }, name: `${owner} project` };
    spyOn(federation, "useFederation").mockReturnValue({
      portalState: {
        selfId: "command",
        self: { projects: [project] },
        nodes: [{ nodeId: "other", projects: [project] }],
      },
    } as never);
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
      if (command === "get_app_version") return target === "leaf" ? "1.0.0" : "2.0.0";
      throw new Error(`Unexpected command: ${command}`);
    };
    workspace.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      response("leaf", command, args),
    );
    window.orkestratorPortal = {
      invoke: mock(async (command: string, args?: Record<string, unknown>) =>
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
      ),
      listen: () => () => {},
    } as never;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AccountMachineProvider value={{ machine, name: owner }}>{children}</AccountMachineProvider>
    );
    const { result } = renderHook(useSettingsModelCatalog, { wrapper });
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
    expect(useAgentModelCatalogStore.getState().codexModels[0]?.id).toBe("leaf-model");
    expect(workspace).not.toHaveBeenCalled();
    expect(await getAppVersion(machine)).toBe("2.0.0");
    expect(await getAppVersion()).toBe("1.0.0");
  });
}
