import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  builtInResourceDefault,
  type DockerCapacity,
} from "@orkestrator/protocol/container-resources";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { useConfigStore } from "@/stores/configStore";
import { ContainerResourceLimitsSettings } from "./ContainerResourceLimitsSettings";

const invoke = nativeInvoke as unknown as ReturnType<typeof mock>;
const initialConfig = useConfigStore.getState().config;
const capacity: DockerCapacity = {
  scope: "docker-daemon",
  cpus: 8,
  memoryBytes: 16 * 1024 ** 3,
  operatingSystem: "Linux",
  rootless: false,
  cgroupVersion: "2",
  support: { cpuQuota: true, memoryLimit: true, pidsLimit: true },
  logDrivers: [],
  disk: {
    imagesBytes: null,
    containersBytes: null,
    volumesBytes: null,
    buildCacheBytes: null,
    measuredAt: null,
  },
};
capacity.builtInDefault = builtInResourceDefault(capacity);

function install(next = capacity) {
  let stored = { ...initialConfig, global: { ...initialConfig.global } };
  delete stored.global.containerResourceLimits;
  useConfigStore.getState().setConfig(stored);
  invoke.mockClear();
  invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "get_docker_capacity") return next;
    if (command === "get_config") return stored;
    if (command === "set_container_resource_limits") {
      stored = { ...stored, global: { ...stored.global } };
      if (args.limits)
        stored.global.containerResourceLimits = args.limits as NonNullable<
          typeof stored.global.containerResourceLimits
        >;
      else delete stored.global.containerResourceLimits;
      return { limits: args.limits };
    }
    throw new Error(`Unexpected command ${command}`);
  });
}

function Settings() {
  const limits = useConfigStore((state) => state.config.global.containerResourceLimits);
  return <ContainerResourceLimitsSettings initial={limits} />;
}

afterEach(() => {
  cleanup();
  useConfigStore.getState().setConfig(initialConfig);
  invoke.mockImplementation(() => Promise.resolve());
});

test("saved Custom, No limits and Built-in default survive remounts from the same store", async () => {
  install();
  let view = render(<Settings />);
  await screen.findByText(/On this Docker/);
  for (const mode of ["Custom", "No limits", "Built-in default"]) {
    fireEvent.click(screen.getByRole("button", { name: mode }));
    if (mode === "Custom")
      fireEvent.change(screen.getByLabelText("Memory (GB)"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() => {
      const limits = useConfigStore.getState().config.global.containerResourceLimits;
      if (mode === "Custom") expect(limits).toEqual({ cpus: null, memoryMiB: 4096, pids: null });
      else if (mode === "No limits")
        expect(limits).toEqual({ cpus: null, memoryMiB: null, pids: null });
      else expect(limits).toBeUndefined();
      expect(screen.getByRole("button", { name: "Save limits" }).hasAttribute("disabled")).toBe(
        false,
      );
    });
    view.unmount();
    view = render(<Settings />);
    expect(screen.getByRole("button", { name: mode }).getAttribute("aria-pressed")).toBe("true");
    if (mode === "Custom")
      expect((screen.getByLabelText("Memory (GB)") as HTMLInputElement).value).toBe("4");
    await screen.findByText(/On this Docker|No limits:|Blank fields/);
  }
});

test("legacy backend disables Built-in default and explains its behavior", async () => {
  const { builtInDefault: _default, ...legacy } = capacity;
  install(legacy);
  render(<Settings />);
  await screen.findByText(/This backend has no built-in default/);
  expect(screen.getByRole("button", { name: "Built-in default" }).hasAttribute("disabled")).toBe(
    true,
  );
});

for (const memoryLimit of [false, true]) {
  test(`warns about unenforced defaults and describes containment accurately (memory=${memoryLimit})`, async () => {
    const next = {
      ...capacity,
      rootless: true,
      support: { cpuQuota: false, memoryLimit, pidsLimit: false },
    };
    install({ ...next, builtInDefault: builtInResourceDefault(next) });
    render(<Settings />);
    await screen.findByText(/This Docker engine cannot enforce the default/);
    expect(screen.getByText(/This Docker engine cannot enforce the default/).textContent).toContain(
      memoryLimit ? "processes" : "memory and processes",
    );
    const description = screen.getByText(/On this Docker/).textContent!;
    expect(description.includes("Contains a runaway")).toBe(memoryLimit);
    if (!memoryLimit) expect(description).toContain("No built-in limit applies on this Docker.");
  });
}
