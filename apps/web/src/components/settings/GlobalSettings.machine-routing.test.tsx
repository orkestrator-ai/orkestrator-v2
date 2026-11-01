import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as backend from "@/lib/backend";
import { useConfigStore } from "@/stores/configStore";
import { AccountMachineProvider } from "./account-machine";
import { MachineConfigProvider } from "./settings-config";
import { GlobalSettings } from "./GlobalSettings";
import type { GlobalSettingsSection } from "@/lib/settings-navigation";

const initial = useConfigStore.getState().config;
let selected = structuredClone(initial);
beforeEach(() => {
  selected = structuredClone(initial);
  selected.global.useHostGitHubCredentials = false;
  selected.global.allowedDomains = ["selected.test"];
  window.orkestratorWorkspaceTarget = { nodeId: "leaf", nodeName: "Leaf", path: "direct" };
  spyOn(backend, "getConfig").mockImplementation(async (target) =>
    target === undefined ? initial : selected,
  );
  spyOn(backend, "getAgentModelCatalogCache").mockResolvedValue({ schemaVersion: 1 });
  spyOn(backend, "getLogDirectory").mockResolvedValue("/selected/logs");
});
afterEach(() => {
  cleanup();
  mock.restore();
  useConfigStore.setState({ config: initial });
  delete window.orkestratorWorkspaceTarget;
});
function mount(section: GlobalSettingsSection, machine: string | null = "other") {
  return render(
    <AccountMachineProvider value={{ machine, name: "Selected" }}>
      <MachineConfigProvider machine={machine}>
        <GlobalSettings activeSection={section} />
      </MachineConfigProvider>
    </AccountMachineProvider>,
  );
}
for (const machine of [null, "other"]) {
  test(`${machine ?? "command node"} autosave, credential writes and GitHub propagation carry the selected target`, async () => {
    const save = spyOn(backend, "updateGlobalConfig").mockImplementation(
      async (global) => (selected = { ...selected, global }),
    );
    const token = spyOn(backend, "setGitHubToken").mockResolvedValue(selected);
    const propagate = spyOn(backend, "propagateGithubCredentialsToContainers").mockResolvedValue({
      updated: [],
      failed: [],
    });
    spyOn(backend, "getGitHubCliStatus").mockResolvedValue({
      installed: false,
      authenticated: false,
      canSignIn: false,
    } as never);
    mount("general", machine);
    const path = await screen.findByLabelText("Default projects folder");
    fireEvent.change(path, { target: { value: "/selected/projects" } });
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ defaultProjectsDirectory: "/selected/projects" }),
        machine,
      ),
    );
    cleanup();
    mount("version-control", machine);
    const requireChecks = await screen.findByRole("switch", {
      name: "Require checks to pass before auto-merge",
    });
    expect(requireChecks.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(requireChecks);
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ autoMergeRequireChecks: true }),
        machine,
      ),
    );
    const field = screen.getByLabelText("GitHub token");
    fireEvent.change(field, { target: { value: "fixture-token" } });
    fireEvent.blur(field);
    await waitFor(() => expect(token).toHaveBeenCalledWith("fixture-token", machine));
    fireEvent.click(screen.getByRole("switch", { name: "Use host GitHub CLI credentials" }));
    await waitFor(() => expect(propagate).toHaveBeenCalledWith(machine));
  });
}

test("remote DNS tests use the selected machine", async () => {
  const testDNS = spyOn(backend, "testDomainResolution").mockResolvedValue([]);
  mount("network");
  fireEvent.click(await screen.findByRole("button", { name: "Test DNS" }));
  await waitFor(() => expect(testDNS).toHaveBeenCalledWith(["selected.test"], "other"));
});

for (const machine of [null, "other"]) {
  test(`${machine ?? "command node"} Debug probes its version, statistics and cleanup without revealing leaf files`, async () => {
    const version = spyOn(backend, "getAppVersion").mockImplementation(async (target) =>
      target === machine ? "2.28.0" : "1.0.0",
    );
    const stats = {
      fileCount: 2,
      totalBytes: 100,
      oldestFile: null,
      newestFile: null,
      retentionDays: 7,
    } as never;
    const read = spyOn(backend, "getLogStorageStats").mockResolvedValue(stats);
    const cleanupLogs = spyOn(backend, "cleanupLogs").mockResolvedValue(stats);
    mount("debug", machine);
    await screen.findByText("2.28.0");
    expect(version).toHaveBeenCalledWith(machine);
    expect(read).toHaveBeenCalledWith(machine);
    expect(
      (screen.getByRole("button", { name: "/selected/logs" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Clean up logs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete logs" }));
    await waitFor(() => expect(cleanupLogs).toHaveBeenCalledWith(machine));
  });
}

test("a different selected backend never changes this window's web server", async () => {
  const save = spyOn(backend, "updateGlobalConfig").mockImplementation(
    async (global) => (selected = { ...selected, global }),
  );
  const enable = spyOn(backend, "setWebClientEnabled");
  spyOn(backend, "getWebClientStatus").mockResolvedValue({
    enabled: true,
    running: false,
    url: null,
    error: null,
    resetAvailable: false,
  });
  spyOn(backend, "getGatewayTokenSettings").mockResolvedValue({
    token: "",
    editable: false,
    source: "environment",
  } as never);
  mount("web-client");
  fireEvent.click(await screen.findByRole("switch", { name: "Allow web access" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ webClientEnabled: false }),
      "other",
    ),
  );
  expect(enable).not.toHaveBeenCalled();
});
