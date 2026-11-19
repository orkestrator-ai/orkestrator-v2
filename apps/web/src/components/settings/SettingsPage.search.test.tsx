import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import * as federation from "@/components/federation/FederationProvider";
import * as commandNode from "@/components/federation/useCommandNode";
import { invoke } from "@/lib/native/backend";
import { portalStore } from "@/lib/portal/portal-store";
import { configStore } from "@/stores";
import { appCommandStore } from "@/test/app-command-store";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { AppConfig, GlobalConfig } from "@/types";
import { useAccountMachineStore } from "./account-machine";
import { SettingsPage } from "./SettingsPage";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const initialPortal = portalStore.getState();
const initialConfig = appCommandStore(configStore).getState();

afterEach(() => {
  cleanup();
  mock.restore();
  portalStore.store.setState(initialPortal);
  appCommandStore(configStore).setState(initialConfig);
  useAccountMachineStore.getState().choose(undefined);
  invokeMock.mockReset();
});

interface Backend {
  config: AppConfig;
  storedKeys: string[];
  resets: Array<Record<string, unknown>>;
  /** Answers for successive reset calls. */
  resetAnswers: Array<"reset" | "conflict">;
}

function install(global: Partial<GlobalConfig>, storedKeys: string[]): Backend {
  spyOn(federation, "useFederation").mockReturnValue({
    enabled: false,
    bound: null,
    portalState: initialPortal,
  } as never);
  spyOn(commandNode, "useCommandNode").mockReturnValue({
    nodeId: "bk_desk" as BackendId,
    name: "Desk",
    colorToken: "teal",
  });
  const backend: Backend = {
    config: {
      ...initialConfig.config,
      global: { ...initialConfig.config.global, ...global } as GlobalConfig,
    },
    storedKeys,
    resets: [],
    resetAnswers: [],
  };
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "get_config":
        return backend.config;
      case "get_global_setting_sources":
        return { storedKeys: backend.storedKeys, inheritedKeys: null };
      case "patch_global_config":
        backend.config = {
          ...backend.config,
          global: { ...backend.config.global, ...(args?.patch as object) } as GlobalConfig,
        };
        return backend.config;
      case "reset_global_settings": {
        backend.resets.push(args ?? {});
        const answer = backend.resetAnswers.shift() ?? "reset";
        const keys = (args?.keys ?? []) as string[];
        if (answer === "reset") {
          const global = { ...backend.config.global } as Record<string, unknown>;
          for (const key of keys) delete global[key];
          backend.config = { ...backend.config, global: global as GlobalConfig };
          backend.storedKeys = backend.storedKeys.filter((key) => !keys.includes(key));
        }
        return {
          status: answer,
          conflicts: answer === "conflict" ? keys : [],
          config: backend.config,
        };
      }
      // Valid answers, so no node poller retries past the end of a test.
      case "get_node_status":
        return { nodeId: "bk_desk" };
      case "get_node_summaries":
        return { selfId: "bk_desk", nodes: [] };
      default:
        return undefined;
    }
  });
  appCommandStore(configStore).setState({ config: backend.config, isLoading: false });
  return backend;
}

function searchField(): HTMLInputElement {
  // The sidebar copy; the narrow-screen copy is the same control in another place.
  return document.getElementById("settings-search-sidebar") as HTMLInputElement;
}

test("a search finds a setting by its alias and opens it, focused and highlighted, unchanged", async () => {
  install({ terminalScrollback: 1000 }, []);
  const onOpenChange = mock(() => undefined);
  renderInAppCommandScope(
    <SettingsPage open defaultSection="general" onOpenChange={onOpenChange} />,
  );
  await screen.findByText("General", { selector: "h2" });

  fireEvent.change(searchField(), { target: { value: "egress" } });
  const results = await screen.findByRole("region", { name: "Settings search results" });
  expect(within(results).getByText("Network whitelist")).toBeTruthy();
  expect(within(results).getByText(/Matches “egress”/)).toBeTruthy();

  fireEvent.change(searchField(), { target: { value: "scrollback" } });
  const result = await within(results).findByRole("button", { name: /Scrollback buffer/ });
  expect(within(results).getByText("Terminal")).toBeTruthy();

  fireEvent.click(result);
  await waitFor(() => {
    const anchor = document.querySelector('[data-setting-anchor="terminal.scrollback"]');
    expect(anchor?.getAttribute("data-setting-highlighted")).toBe("true");
    expect(anchor?.contains(document.activeElement)).toBe(true);
  });
  expect(screen.queryByRole("region", { name: "Settings search results" }) === null).toBe(true);
  expect(screen.getByTestId("settings-navigation-status").textContent).toContain(
    "Showing Scrollback buffer",
  );
  // Navigation saved nothing.
  expect(invokeMock.mock.calls.some(([command]) => command === "patch_global_config")).toBe(false);
  expect(onOpenChange).not.toHaveBeenCalled();
});

test("Escape clears the search instead of closing Settings, and Enter opens the first result", async () => {
  install({}, []);
  const onOpenChange = mock(() => undefined);
  renderInAppCommandScope(
    <SettingsPage open defaultSection="general" onOpenChange={onOpenChange} />,
  );
  await screen.findByText("General", { selector: "h2" });

  fireEvent.change(searchField(), { target: { value: "auto merge" } });
  await screen.findByRole("region", { name: "Settings search results" });
  fireEvent.keyDown(searchField(), { key: "Escape" });
  expect(searchField().value).toBe("");
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "Settings search results" }) === null).toBe(true);

  fireEvent.change(searchField(), { target: { value: "auto merge" } });
  await screen.findByRole("region", { name: "Settings search results" });
  fireEvent.keyDown(searchField(), { key: "Enter" });
  await waitFor(() =>
    expect(
      document
        .querySelector('[data-setting-anchor="version-control.auto-merge-require-checks"]')
        ?.contains(document.activeElement),
    ).toBe(true),
  );
});

test("an unavailable result says why and opens the setting that shows it", async () => {
  install({ terminalHistoryEnabled: false }, []);
  renderInAppCommandScope(
    <SettingsPage open defaultSection="general" onOpenChange={() => undefined} />,
  );
  await screen.findByText("General", { selector: "h2" });
  fireEvent.change(searchField(), { target: { value: "completed terminal history" } });
  const results = await screen.findByRole("region", { name: "Settings search results" });
  expect(
    within(results).getByText(/Not shown now: Turn on Backend history retention/),
  ).toBeTruthy();
  fireEvent.click(within(results).getByRole("button", { name: /Completed terminal history/ }));
  await waitFor(() =>
    expect(
      document
        .querySelector('[data-setting-anchor="terminal.history-retention"]')
        ?.contains(document.activeElement),
    ).toBe(true),
  );
  expect(screen.getByTestId("settings-navigation-status").textContent).toContain(
    "Completed terminal history is not shown now",
  );
});

test("fields explain their effective value and source; Modified tells overrides from defaults", async () => {
  install({ debugLogging: true, autoSteer: false }, ["debugLogging", "autoSteer"]);
  renderInAppCommandScope(
    <SettingsPage open defaultSection="debug" onOpenChange={() => undefined} />,
  );
  const explanation = await waitFor(() => {
    const element = document.querySelector('[data-setting-explanation="debug.save-logs"]');
    expect(element?.textContent).toContain("Set on Desk");
    return element!;
  });
  expect(explanation.textContent).toContain("Effective: On");
  expect(explanation.textContent).toContain("Applies immediately");
  expect(explanation.textContent).toContain("Override");

  fireEvent.click(screen.getAllByRole("button", { name: "Show modified settings" })[0]!);
  const modified = await screen.findByRole("region", { name: "Modified settings" });
  const logs = within(modified)
    .getByRole("button", { name: /^Save logs to disk/ })
    .closest("li")!;
  expect(logs.textContent).toContain("Override");
  expect(logs.textContent).not.toContain("same as default");
  const steer = within(modified)
    .getByRole("button", { name: /^Auto-steer/ })
    .closest("li")!;
  expect(steer.textContent).toContain("Override · same as default");
  expect(within(modified).queryByRole("button", { name: /Scrollback buffer/ }) === null).toBe(true);
});

test("a reset previews its effect, refuses a value that moved, and removes the override on confirm", async () => {
  const backend = install({ debugLogging: true }, ["debugLogging"]);
  backend.resetAnswers = ["conflict", "reset"];
  renderInAppCommandScope(
    <SettingsPage open defaultSection="debug" onOpenChange={() => undefined} />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Reset Save logs to disk to default" }),
  );

  const dialog = await screen.findByRole("alertdialog");
  const preview = await within(dialog).findByTestId("reset-preview");
  expect(preview.textContent).toContain("NowOn");
  expect(preview.textContent).toContain("After resetOff (default)");
  expect(within(dialog).getByText(/value stored on/).textContent).toContain("Desk");

  fireEvent.click(within(dialog).getByRole("button", { name: "Reset to default" }));
  expect(await within(dialog).findByText(/changed since you opened this preview/)).toBeTruthy();
  expect(backend.resets).toHaveLength(1);
  expect(backend.resets[0]).toEqual({
    keys: ["debugLogging"],
    expect: [{ key: "debugLogging", present: true, value: true }],
  });

  await act(async () => {
    fireEvent.click(await within(dialog).findByRole("button", { name: "Reset to default" }));
  });
  await waitFor(() => expect(screen.queryByRole("alertdialog") === null).toBe(true));
  expect(backend.resets).toHaveLength(2);
  await waitFor(() => {
    const explanation = document.querySelector('[data-setting-explanation="debug.save-logs"]');
    expect(explanation?.textContent).toContain("Default; nothing stored on Desk");
  });
});

test("search keeps an unsaved edit and asks before leaving the form with one that cannot save", async () => {
  install({ allowedDomains: ["github.com"] }, []);
  renderInAppCommandScope(
    <SettingsPage open defaultSection="network" onOpenChange={() => undefined} />,
  );
  const domains = (await screen.findByRole("textbox", {
    name: "Allowed domains",
  })) as HTMLTextAreaElement;
  fireEvent.change(domains, { target: { value: "github.com\nnot a domain!!" } });
  await screen.findByText(/Not saved/);

  // Searching hides the section without unmounting it, so the edit is still there.
  fireEvent.change(searchField(), { target: { value: "agent stopped" } });
  const results = await screen.findByRole("region", { name: "Settings search results" });
  fireEvent.click(within(results).getByRole("button", { name: /^Agent stopped sound/ }));
  const conflict = await within(results).findByRole("alertdialog");
  expect(conflict.textContent).toContain("cannot be saved yet");

  fireEvent.click(within(conflict).getByRole("button", { name: "Fix the change first" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Settings search results" }) === null).toBe(true),
  );
  expect(
    (screen.getByRole("textbox", { name: "Allowed domains" }) as HTMLTextAreaElement).value,
  ).toBe("github.com\nnot a domain!!");
  expect(invokeMock.mock.calls.some(([command]) => command === "patch_global_config")).toBe(false);
});
