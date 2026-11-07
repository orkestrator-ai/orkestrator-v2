import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
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
// The command node itself is this window's own machine (the window's suites).
for (const machine of ["other"]) {
  test(`${machine} autosave, credential writes and GitHub propagation carry the selected target`, async () => {
    const save = spyOn(backend, "patchGlobalConfig").mockImplementation(
      async (patch) => (selected = { ...selected, global: { ...selected.global, ...patch } }),
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
        { defaultProjectsDirectory: "/selected/projects" },
        { unset: [], machine },
      ),
    );
    cleanup();
    mount("version-control", machine);
    const requireChecks = await screen.findByRole("switch", {
      name: "Require checks to pass before auto-merge",
    });
    expect(requireChecks.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(requireChecks);
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ autoMergeRequireChecks: false }),
        { unset: [], machine },
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

for (const machine of ["other"]) {
  test(`${machine} Debug probes its version, statistics and cleanup without revealing leaf files`, async () => {
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

test("Debug says the event log is always kept, with its size apart from what cleaning removes", async () => {
  spyOn(backend, "getAppVersion").mockResolvedValue("2.28.0");
  spyOn(backend, "getLogStorageStats").mockResolvedValue({
    fileCount: 2,
    totalBytes: 100,
    essentialBytes: 2048,
    essentialFileCount: 1,
  } as never);
  mount("debug");
  await screen.findByText(/always kept, even with this off/);
  expect(
    screen.getByText(/holds no prompts, paths or file contents, and has a fixed 4 MiB size limit/),
  ).toBeTruthy();
  await screen.findByText("Event log, not removed by clean up: 2 KB");
});

test("a backend older than the event log shows no line for it", async () => {
  spyOn(backend, "getAppVersion").mockResolvedValue("2.28.0");
  spyOn(backend, "getLogStorageStats").mockResolvedValue({
    fileCount: 2,
    totalBytes: 100,
  } as never);
  mount("debug");
  await screen.findByText(/across 2 files/);
  expectDomAbsent(screen.queryByText(/not removed by clean up/));
});

test("a different selected backend never changes this window's web server", async () => {
  const save = spyOn(backend, "patchGlobalConfig").mockImplementation(
    async (patch) => (selected = { ...selected, global: { ...selected.global, ...patch } }),
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
    expect(save).toHaveBeenCalledWith({ webClientEnabled: false }, { unset: [], machine: "other" }),
  );
  expect(enable).not.toHaveBeenCalled();
});

for (const machine of ["leaf", "other", null]) {
  test(`Auto-steer can be changed with ${machine ?? "command node"} selected`, async () => {
    const save = spyOn(backend, "patchGlobalConfig").mockImplementation(
      async (patch) => (selected = { ...selected, global: { ...selected.global, ...patch } }),
    );
    mount("general", machine);
    fireEvent.click(await screen.findByRole("switch", { name: "Auto-steer" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ autoSteer: true }, { unset: [], machine }),
    );
  });
}

for (const inherited of [false, true]) {
  test(`a direct leaf window adopts inherited Auto-steer ${inherited} after one masked save`, async () => {
    useConfigStore.setState({
      config: { ...initial, global: { ...initial.global, autoSteer: inherited } },
    });
    const save = spyOn(backend, "patchGlobalConfig").mockResolvedValue({
      ...initial,
      global: { ...initial.global, autoSteer: inherited },
    });
    render(<GlobalSettings activeSection="general" />);
    const toggle = await screen.findByRole("switch", { name: "Auto-steer" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe(String(!inherited));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe(String(inherited)));
    // Wait past a second debounce, and unmount to cover the close-time flush.
    await new Promise((resolve) => setTimeout(resolve, 700));
    cleanup();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(inherited ? {} : { autoSteer: true }, {
      unset: inherited ? ["autoSteer"] : [],
      machine: undefined,
    });
  });
}

test("an Auto-steer edit made during a save survives the earlier response", async () => {
  useConfigStore.setState({
    config: { ...initial, global: { ...initial.global, autoSteer: false } },
  });
  let finishSave!: (config: typeof initial) => void;
  const pending = new Promise<typeof initial>((resolve) => {
    finishSave = resolve;
  });
  const save = spyOn(backend, "patchGlobalConfig")
    .mockImplementationOnce(() => pending)
    .mockResolvedValue({ ...initial, global: { ...initial.global, autoSteer: false } });
  render(<GlobalSettings activeSection="general" />);
  const toggle = await screen.findByRole("switch", { name: "Auto-steer" });
  fireEvent.click(toggle);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  fireEvent.click(toggle);
  finishSave({ ...initial, global: { ...initial.global, autoSteer: true } });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(save).toHaveBeenLastCalledWith({}, { unset: ["autoSteer"], machine: undefined });
});
