import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import * as backend from "@/lib/backend";
import { configStore } from "@/stores/configStore";
import { AccountMachineProvider } from "./account-machine";
import { MachineConfigProvider } from "./settings-config";
import { GlobalSettings } from "./GlobalSettings";
import { ADDRESS_FINDINGS_PRE_EXISTING_LABEL } from "./AddressFindingsPreExistingSetting";
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
        <GlobalSettings activeSection="review" />
      </MachineConfigProvider>
    </AccountMachineProvider>,
  );
}

test("Settings → Review shows the pre-existing failure switch, off by default, with its trade-off", async () => {
  mount();
  const toggle = await screen.findByRole("switch", { name: ADDRESS_FINDINGS_PRE_EXISTING_LABEL });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  const description = document.getElementById("address-findings-pre-existing-description");
  expect(toggle.getAttribute("aria-describedby")).toBe("address-findings-pre-existing-description");
  expect(description?.textContent).toContain("separate commits");
  expect(description?.textContent).toContain("Pull requests get larger");
  expect(description?.textContent).toContain("race to fix the same test");
});

test("turning the switch on saves it, and turning it off removes the stored value", async () => {
  const save = spyOn(backend, "patchGlobalConfig").mockImplementation(async (patch, options) => {
    const global = { ...selected.global, ...patch };
    for (const key of options?.unset ?? []) delete (global as Record<string, unknown>)[key];
    selected = { ...selected, global };
    return selected;
  });
  mount();
  const toggle = await screen.findByRole("switch", { name: ADDRESS_FINDINGS_PRE_EXISTING_LABEL });
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      { addressFindingsRepairsPreExisting: true },
      { unset: [], machine: null },
    ),
  );
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith(
      {},
      { unset: ["addressFindingsRepairsPreExisting"], machine: null },
    ),
  );
});

test("a stored value shows on reopen", async () => {
  const stored = {
    ...initial,
    global: { ...initial.global, addressFindingsRepairsPreExisting: true },
  };
  selected = stored;
  appCommandStore(configStore).getState().setConfig(stored);
  mount();
  const toggle = await screen.findByRole("switch", { name: ADDRESS_FINDINGS_PRE_EXISTING_LABEL });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});
