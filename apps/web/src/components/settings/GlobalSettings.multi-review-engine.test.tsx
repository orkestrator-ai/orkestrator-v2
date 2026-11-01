import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as backend from "@/lib/backend";
import { useConfigStore } from "@/stores/configStore";
import { AccountMachineProvider } from "./account-machine";
import { MachineConfigProvider } from "./settings-config";
import { GlobalSettings } from "./GlobalSettings";

const initial = useConfigStore.getState().config;
let selected = structuredClone(initial);

beforeEach(() => {
  selected = structuredClone(initial);
  spyOn(backend, "getConfig").mockImplementation(async () => selected);
  spyOn(backend, "getAgentModelCatalogCache").mockResolvedValue({ schemaVersion: 1 });
});

afterEach(() => {
  cleanup();
  mock.restore();
  useConfigStore.setState({ config: initial });
});

function mount() {
  return render(
    <AccountMachineProvider value={{ machine: null, name: "Local" }}>
      <MachineConfigProvider machine={null}>
        <GlobalSettings activeSection="review" />
      </MachineConfigProvider>
    </AccountMachineProvider>,
  );
}

test("the Multi Review runtime defaults to the engine and saves the graph runtime when chosen", async () => {
  const save = spyOn(backend, "patchGlobalConfig").mockImplementation(
    async (patch) => (selected = { ...selected, global: { ...selected.global, ...patch } }),
  );
  mount();
  const engine = (await screen.findByRole("radio", {
    name: /Multi Review engine/,
  })) as HTMLInputElement;
  expect(engine.checked).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: /Graph runtime \(preview\)/ }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({ multiReviewEngine: "graph" }, { unset: [], machine: null }),
  );
});
