import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as backend from "@/lib/backend";
import { configStore } from "@/stores/configStore";
import { MachineConfigProvider, useSettingsConfig } from "./settings-config";
import { appCommandStore } from "@/test/app-command-store";

const initial = appCommandStore(configStore).getState().config;
function config(owner: string) {
  return {
    ...initial,
    version: owner,
    repositories: { [owner]: { defaultBranch: "main", prBaseBranch: "main" } },
    global: { ...initial.global, defaultProjectsDirectory: `/${owner}` },
  };
}
function Child() {
  const { config, setConfig } = useSettingsConfig();
  return (
    <>
      <output>{config.version}</output>
      <button onClick={() => setConfig({ ...config, version: `${config.version}-saved` })}>
        Save
      </button>
    </>
  );
}
afterEach(() => {
  cleanup();
  mock.restore();
  appCommandStore(configStore).setState({ config: initial });
});

test("implicit workspace config uses the window store without an independent read", () => {
  appCommandStore(configStore).setState({ config: config("workspace") });
  const read = spyOn(backend, "getConfig");
  render(
    <MachineConfigProvider machine={undefined}>
      <Child />
    </MachineConfigProvider>,
  );
  expect(screen.getByRole("status").textContent).toBe("workspace");
  expect(read).not.toHaveBeenCalled();
});

// The command node itself is this window's own machine.
for (const machine of ["other"]) {
  test(`explicit ${machine ?? "command-node"} config stays isolated and refreshes effective workspace after save`, async () => {
    appCommandStore(configStore).setState({ config: config("leaf") });
    const read = spyOn(backend, "getConfig").mockImplementation(async (target) =>
      config(target === undefined ? "leaf-refreshed" : "selected"),
    );
    render(
      <MachineConfigProvider machine={machine}>
        <Child />
      </MachineConfigProvider>,
    );
    await screen.findByText("selected");
    expect(read).toHaveBeenCalledWith(machine);
    expect(appCommandStore(configStore).getState().config.version).toBe("leaf");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(appCommandStore(configStore).getState().config.version).toBe("leaf-refreshed"),
    );
    expect(read).toHaveBeenLastCalledWith();
    expect(screen.getByRole("status").textContent).toBe("selected-saved");
    expect(appCommandStore(configStore).getState().config.repositories).toEqual({
      "leaf-refreshed": { defaultBranch: "main", prBaseBranch: "main" },
    });
  });
}

test("shows loading and a retryable read error, then renders recovered settings", async () => {
  let reject!: (cause: Error) => void;
  const read = spyOn(backend, "getConfig")
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue(config("recovered"));
  render(
    <MachineConfigProvider machine="other">
      <Child />
    </MachineConfigProvider>,
  );
  expect(screen.queryByRole("button", { name: "Save" }) === null).toBe(true);
  await act(async () => reject(new Error("offline")));
  expect(screen.getByRole("alert").textContent).toContain("offline");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("recovered");
  expect(read.mock.calls).toEqual([["other"], ["other"]]);
});

test("changing target cancels late reads and does not expose the previous config", async () => {
  let resolve!: (value: typeof initial) => void;
  spyOn(backend, "getConfig")
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue(config("second"));
  const view = render(
    <MachineConfigProvider machine="first">
      <Child />
    </MachineConfigProvider>,
  );
  view.rerender(
    <MachineConfigProvider machine="second">
      <Child />
    </MachineConfigProvider>,
  );
  await screen.findByText("second");
  await act(async () => resolve(config("first")));
  expect(screen.getByRole("status").textContent).toBe("second");
  expect(appCommandStore(configStore).getState().config).toBe(initial);
});
