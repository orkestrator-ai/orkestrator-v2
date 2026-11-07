import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as backend from "@/lib/backend";
import { GLOBAL_SETTINGS_SECTIONS, onGlobalSettingsRequest } from "@/lib/settings-navigation";
import { configStore } from "@/stores/configStore";
import { AccountMachineProvider } from "./account-machine";
import { MachineConfigProvider } from "./settings-config";
import { GlobalSettings } from "./GlobalSettings";
import { appCommandStore } from "@/test/app-command-store";

const initial = appCommandStore(configStore).getState().config;

beforeEach(() => {
  spyOn(backend, "getConfig").mockImplementation(async () => structuredClone(initial));
  spyOn(backend, "getAgentModelCatalogCache").mockResolvedValue({ schemaVersion: 1 });
});

afterEach(() => {
  cleanup();
  mock.restore();
  appCommandStore(configStore).setState({ config: initial });
});

function mount(section: string) {
  return render(
    <AccountMachineProvider value={{ machine: null, name: "Local" }}>
      <MachineConfigProvider machine={null}>
        <GlobalSettings activeSection={section} />
      </MachineConfigProvider>
    </AccountMachineProvider>,
  );
}

test("the Coordinator section is a place Settings can open", () => {
  expect(GLOBAL_SETTINGS_SECTIONS).toContain("coordinator");
});

test("it holds the safety level and web research, and links messaging", async () => {
  mount("coordinator");
  expect(await screen.findByRole("heading", { level: 2, name: "Coordinator" })).toBeTruthy();
  expect(screen.getByRole("radiogroup", { name: "Coordinator safety level" })).toBeTruthy();
  expect(screen.getByRole("radiogroup", { name: "Coordinator web research" })).toBeTruthy();
  expect(screen.getByText(/Coordinator status updates are set there/)).toBeTruthy();

  const opened: string[] = [];
  const off = onGlobalSettingsRequest((section) => opened.push(section));
  fireEvent.click(screen.getByRole("button", { name: "Open Messaging settings" }));
  off();
  expect(opened).toEqual(["messaging"]);
});

test("Platforms no longer holds them, and says where they went", async () => {
  mount("platforms");
  expect(await screen.findByRole("heading", { level: 2, name: "Agent platforms" })).toBeTruthy();
  expect(screen.queryByRole("radiogroup", { name: "Coordinator safety level" }) === null).toBe(
    true,
  );
  expect(screen.queryByRole("radiogroup", { name: "Coordinator web research" }) === null).toBe(
    true,
  );
  const opened: string[] = [];
  const off = onGlobalSettingsRequest((section) => opened.push(section));
  fireEvent.click(screen.getByRole("button", { name: "Coordinator settings" }));
  off();
  expect(opened).toEqual(["coordinator"]);
});
