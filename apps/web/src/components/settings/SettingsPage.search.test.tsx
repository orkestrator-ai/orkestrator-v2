import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import * as federation from "@/components/federation/FederationProvider";
import * as nodeEvents from "@/lib/federation/node-events";
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
  inheritedKeys: string[] | null;
  beforeReset?: () => unknown | Promise<unknown>;
  dropPatchResponse?: boolean;
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
    inheritedKeys: null,
  };
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "get_config":
        return backend.config;
      case "get_global_setting_sources":
        return { storedKeys: backend.storedKeys, inheritedKeys: backend.inheritedKeys };
      case "patch_global_config":
        backend.config = {
          ...backend.config,
          global: { ...backend.config.global, ...(args?.patch as object) } as GlobalConfig,
        };
        if (backend.dropPatchResponse) throw new Error("Response lost");
        return backend.config;
      case "reset_global_settings": {
        backend.resets.push(args ?? {});
        await backend.beforeReset?.();
        const keys = (args?.keys ?? []) as string[];
        const expected = (args?.expect ?? []) as Array<{ key: keyof GlobalConfig; value: unknown }>;
        const answer = expected.every((entry) => backend.config.global[entry.key] === entry.value)
          ? "reset"
          : "conflict";
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
  backend.beforeReset = () => {
    backend.config = {
      ...backend.config,
      global: { ...backend.config.global, debugLogging: false },
    };
    backend.beforeReset = undefined;
  };
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
  expect(backend.resets[1]?.expect).toEqual([{ key: "debugLogging", present: true, value: false }]);
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

test("a controller-owned value is explained without offering reset", async () => {
  const backend = install({ autoSteer: true }, ["autoSteer"]);
  backend.inheritedKeys = ["autoSteer"];
  renderInAppCommandScope(
    <SettingsPage open defaultSection="general" onOpenChange={() => undefined} />,
  );
  const anchor = (await screen.findByRole("switch", { name: "Auto-steer" })).closest(
    "[data-setting-anchor]",
  ) as HTMLElement;
  expect(
    await within(anchor).findByText(/Inherited from the command node this machine follows/),
  ).toBeTruthy();
  expect(within(anchor).queryByRole("button", { name: /Reset/ }) === null).toBe(true);
  expect(backend.resets).toHaveLength(0);
});

test("while reset is pending Escape cannot dismiss it, and a late reply cannot replace a newer draft", async () => {
  const backend = install({ debugLogging: true }, ["debugLogging"]);
  const pending = Promise.withResolvers<void>();
  backend.beforeReset = () => pending.promise;
  const rendered = renderInAppCommandScope(
    <SettingsPage open defaultSection="debug" onOpenChange={() => undefined} />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Reset Save logs to disk to default" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  await within(dialog).findByTestId("reset-preview");
  fireEvent.click(within(dialog).getByRole("button", { name: "Reset to default" }));
  expect(
    (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("alertdialog")).toBe(dialog);

  // An app-level request can still replace Settings. A late response must
  // not touch the newly opened form or replace its draft.
  rendered.rerender(<SettingsPage open defaultSection="network" onOpenChange={() => undefined} />);
  const domains = (await screen.findByRole("textbox", {
    name: "Allowed domains",
  })) as HTMLTextAreaElement;
  fireEvent.change(domains, { target: { value: "NOT a valid domain!" } });
  await act(async () => pending.resolve());
  expect(domains.value).toBe("NOT a valid domain!");
  expect(screen.queryByRole("alertdialog") === null).toBe(true);
});

test("checking a lost save response preserves the draft and never replays the patch", async () => {
  const backend = install({ terminalScrollback: 1000 }, []);
  backend.dropPatchResponse = true;
  renderInAppCommandScope(
    <SettingsPage open defaultSection="general" onOpenChange={() => undefined} />,
  );
  const folder = (await screen.findByRole("textbox", {
    name: "Default projects folder",
  })) as HTMLInputElement;
  fireEvent.change(folder, { target: { value: "/draft/projects" } });
  const check = await screen.findByRole("button", { name: "Check saved values" });
  backend.config = {
    ...backend.config,
    global: { ...backend.config.global, defaultProjectsDirectory: "/other-client" },
  };
  fireEvent.click(check);
  expect(await screen.findByText(/saved values differ/)).toBeTruthy();
  expect(folder.value).toBe("/draft/projects");
  expect(
    invokeMock.mock.calls.filter(([command]) => command === "patch_global_config"),
  ).toHaveLength(1);

  fireEvent.change(searchField(), { target: { value: "agent stopped sound" } });
  fireEvent.click(await screen.findByRole("button", { name: /^Agent stopped sound/ }));
  const confirm = await screen.findByRole("alertdialog");
  fireEvent.click(within(confirm).getByRole("button", { name: "Fix the change first" }));
  expect(folder.value).toBe("/draft/projects");
});

function installRemote() {
  const command = install({ debugLogging: false }, ["debugLogging"]);
  const remote = {
    ...command.config,
    global: { ...command.config.global, debugLogging: true, experimentalGraphs: true },
  };
  const nodeId = "bk_remote" as BackendId;
  let offline = false;
  const listeners = new Set<nodeEvents.NodeEventSubscriber>();
  spyOn(nodeEvents, "subscribeNodeEvents").mockImplementation((_node, listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  const mockFederation = spyOn(federation, "useFederation");
  const connection = (state: "connected" | "unavailable") => {
    const nodes = [
      {
        nodeId,
        view: { displayName: "Build box", connection: { state } },
        projects: [],
        environments: [],
        freshness: "current",
      },
    ] as unknown as typeof initialPortal.nodes;
    const portal = { ...initialPortal, selfId: "bk_desk" as BackendId, nodes };
    portalStore.store.setState(portal);
    mockFederation.mockReturnValue({
      enabled: true,
      bound: {
        name: "Desk",
        backendId: portal.selfId,
        connectionId: portal.selfId,
        colorToken: "teal",
      },
      portalState: portal,
    } as never);
  };
  connection("connected");
  useAccountMachineStore.getState().choose(nodeId);
  const invokeLocal = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    if (name !== "invoke_on_node") return invokeLocal(name, args);
    if (args?.command === "get_config" && offline) throw new Error("Machine unavailable");
    return {
      outcome: "ok",
      result:
        args?.command === "get_config"
          ? { ...remote, global: { ...remote.global } }
          : args?.command === "get_global_setting_sources"
            ? { storedKeys: ["debugLogging", "experimentalGraphs"], inheritedKeys: null }
            : undefined,
    };
  });
  return {
    remote,
    connection,
    remoteChange() {
      for (const listener of listeners)
        listener.onEvent("resource-changed", { resource: "config", id: "app", revision: 2 });
    },
    failRead: () => {
      offline = true;
    },
  };
}

test("search from Review describes and opens the selected remote, then refreshes on reconnect", async () => {
  const { remote, connection, remoteChange } = installRemote();
  const page = <SettingsPage open defaultSection="review" onOpenChange={() => undefined} />;
  const rendered = renderInAppCommandScope(page);
  fireEvent.change(searchField(), { target: { value: "save logs to disk" } });
  const results = await screen.findByRole("region", { name: "Settings search results" });
  await within(results).findByText(/On · Set on Build box/);
  const row = within(results)
    .getByRole("button", { name: /^Save logs to disk/ })
    .closest("li");
  expect(row?.textContent).toContain("Machine setting · Build box");
  fireEvent.click(within(results).getByRole("button", { name: /^Save logs to disk/ }));
  const setting = await screen.findByRole("switch", { name: "Save logs to disk" });
  await waitFor(() => expect(setting === document.activeElement).toBe(true));
  expect(setting.getAttribute("aria-checked")).toBe("true");

  act(() => {
    connection("unavailable");
    rendered.rerender(<SettingsPage open defaultSection="review" onOpenChange={() => undefined} />);
  });
  await screen.findByText(/This machine is disconnected/);
  remote.global.debugLogging = false;
  act(() => {
    connection("connected");
    rendered.rerender(<SettingsPage open defaultSection="review" onOpenChange={() => undefined} />);
  });
  await screen.findByText("Set on Build box");
  expect(
    (await screen.findByRole("switch", { name: "Save logs to disk" })).getAttribute("aria-checked"),
  ).toBe("false");

  remote.global.debugLogging = true;
  act(remoteChange);
  await waitFor(() => expect(setting.getAttribute("aria-checked")).toBe("true"));

  fireEvent.click(screen.getAllByRole("button", { name: "Show modified settings" })[0]!);
  const modified = await screen.findByRole("region", { name: "Modified settings" });
  const graphs = (await within(modified).findByRole("button", { name: /^Graphs/ })).closest(
    "li",
  ) as HTMLLIElement;
  expect(graphs.textContent).toContain("Experimental settings belong");
  expect(within(graphs).queryByRole("button", { name: /Reset/ }) === null).toBe(true);
});

test("a failed remote read leaves command-node search and navigation usable", async () => {
  const { failRead } = installRemote();
  failRead();
  renderInAppCommandScope(
    <SettingsPage open defaultSection="network" onOpenChange={() => undefined} />,
  );
  await screen.findByText(/Machine unavailable/);
  fireEvent.change(searchField(), { target: { value: "code review instruction" } });
  fireEvent.click(await screen.findByRole("button", { name: /^Code review instruction/ }));
  await screen.findByRole("heading", { name: "Review" });
});

test("invalid remote Network draft survives a search result that opens command-node Review", async () => {
  installRemote();
  renderInAppCommandScope(
    <SettingsPage open defaultSection="network" onOpenChange={() => undefined} />,
  );
  const domains = (await screen.findByRole("textbox", {
    name: "Allowed domains",
  })) as HTMLTextAreaElement;
  fireEvent.change(domains, { target: { value: "this is invalid!" } });
  fireEvent.change(searchField(), { target: { value: "code review instruction" } });
  fireEvent.click(await screen.findByRole("button", { name: /^Code review instruction/ }));
  const confirm = await screen.findByRole("alertdialog");
  fireEvent.click(within(confirm).getByRole("button", { name: "Fix the change first" }));
  await waitFor(() => expect(document.activeElement).toBe(domains));
  expect(domains.value).toBe("this is invalid!");
});
