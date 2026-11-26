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

const original = appCommandStore(configStore).getState().config;
const initial = {
  ...original,
  global: { ...original.global, addressFindingsPreExistingRepairSupported: true },
};
let selected: typeof original = structuredClone(initial);

beforeEach(() => {
  selected = structuredClone(initial);
  appCommandStore(configStore).getState().setConfig(selected);
  spyOn(backend, "getConfig").mockImplementation(async () => selected);
  spyOn(backend, "getAgentModelCatalogCache").mockResolvedValue({ schemaVersion: 1 });
});

afterEach(() => {
  cleanup();
  mock.restore();
  appCommandStore(configStore).setState({ config: original });
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

test("an older command node's stored echo leaves the switch off and prevents saving after reopen", async () => {
  const older = {
    ...original,
    global: { ...original.global, addressFindingsRepairsPreExisting: true },
  };
  selected = older;
  appCommandStore(configStore).getState().setConfig(older);
  const save = spyOn(backend, "patchGlobalConfig").mockResolvedValue(older);
  for (const reopen of [false, true]) {
    const { unmount } = mount();
    const toggle = await screen.findByRole("switch", { name: ADDRESS_FINDINGS_PRE_EXISTING_LABEL });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/command node does not support this setting/)).toBeDefined();
    if (!reopen) fireEvent.click(toggle);
    unmount();
  }
  expect(save).not.toHaveBeenCalled();
});

test("losing command-node support during a save does not adopt the echoed value", async () => {
  const savedByOldNode = {
    ...original,
    global: { ...original.global, addressFindingsRepairsPreExisting: true },
  };
  const save = spyOn(backend, "patchGlobalConfig").mockImplementation(async () => {
    selected = savedByOldNode;
    return selected;
  });
  const { unmount } = mount();
  const toggle = await screen.findByRole("switch", { name: ADDRESS_FINDINGS_PRE_EXISTING_LABEL });
  fireEvent.click(toggle);
  await waitFor(() => {
    expect(save).toHaveBeenCalledTimes(1);
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
  unmount();
  mount();
  const reopened = await screen.findByRole("switch", { name: ADDRESS_FINDINGS_PRE_EXISTING_LABEL });
  expect(reopened.hasAttribute("disabled")).toBe(true);
  expect(reopened.getAttribute("aria-checked")).toBe("false");
});
