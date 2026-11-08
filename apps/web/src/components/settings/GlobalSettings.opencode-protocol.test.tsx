import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import * as backend from "@/lib/backend";
import { configStore } from "@/stores/configStore";
import { AccountMachineProvider } from "./account-machine";
import { MachineConfigProvider } from "./settings-config";
import { GlobalSettings } from "./GlobalSettings";
import { appCommandStore } from "@/test/app-command-store";

const initial = appCommandStore(configStore).getState().config;
let selected = structuredClone(initial);

beforeEach(() => {
  selected = structuredClone(initial);
  spyOn(backend, "getConfig").mockImplementation(async () => selected);
  spyOn(backend, "getAgentModelCatalogCache").mockResolvedValue({ schemaVersion: 1 });
});

afterEach(() => {
  cleanup();
  mock.restore();
  appCommandStore(configStore).setState({ config: initial });
});

function mount() {
  return renderInAppCommandScope(
    <AccountMachineProvider value={{ machine: null, name: "Local" }}>
      <MachineConfigProvider machine={null}>
        <GlobalSettings activeSection="opencode" />
      </MachineConfigProvider>
    </AccountMachineProvider>,
  );
}

test("the OpenCode 2 preview is off by default and saves v2 when turned on", async () => {
  const save = spyOn(backend, "patchGlobalConfig").mockImplementation(
    async (patch) => (selected = { ...selected, global: { ...selected.global, ...patch } }),
  );
  mount();
  const toggle = await screen.findByRole("switch", {
    name: "Use OpenCode 2 for new sessions (preview)",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({ openCodeProtocol: "v2" }, { unset: [], machine: null }),
  );
});
