import { describe, expect, test } from "bun:test";
import { GLOBAL_SETTINGS_SECTIONS } from "@/lib/settings-navigation";
import { GLOBAL_SETTINGS_CATALOG } from "@/lib/settings-catalog";
import { COMMAND_CATALOG, commandById } from "./catalog";
import { buildPaletteContext } from "./context";
import {
  commandAvailability,
  commandTarget,
  describeTargetMachine,
  type CommandDescriptor,
  type CommandRuntime,
} from "./model";
import {
  environment,
  localContext,
  localProject,
  localWorktree,
  machineView,
  runningContainer,
} from "./palette.test-fixtures";

function command(id: string): CommandDescriptor {
  const found = commandById(id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
}

const mbp3 = machineView(
  "bk_mbp3",
  "mbp3",
  [{ id: "ork-3", name: "orkestrator-v2", gitUrl: "https://github.com/acme/orkestrator-v2.git" }],
  [
    {
      id: "box",
      projectId: "ork-3",
      name: "build-modal-steps",
      status: "running",
      environmentType: "containerized",
    },
  ],
);
const studio = machineView("bk_self", "studio", [], [], { bound: true });

function remoteContext(machine = mbp3, environmentId = "box") {
  const selection = { nodeId: machine.backendId, projectId: "ork-3", environmentId };
  return buildPaletteContext({
    selection,
    shownSelection: selection,
    machines: [studio, machine],
    onWindowMachine: false,
    localProjects: [localProject],
    // The same name on this machine must never stand in for mbp3's environment.
    localEnvironments: [{ ...runningContainer, id: "box" }],
    localDeleting: new Set(),
    pending: new Set(),
    dockerAvailable: true,
    requireChecks: false,
    handlers: { environmentPower: true, addProject: true },
    recentCommandCount: 0,
    rememberRecentCommands: true,
    settingsFlags: {},
  });
}

describe("command catalogue", () => {
  test("every command has a unique stable id, a label, a group and a handler", () => {
    const ids = COMMAND_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of COMMAND_CATALOG) {
      expect(entry.id).toMatch(/^(environment|project|app|settings)\.[a-z0-9-]+$/);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(typeof entry.run).toBe("function");
      expect(["actions", "settings"]).toContain(entry.group);
    }
  });

  test("lists every Settings section from the one settings catalogue", () => {
    for (const section of GLOBAL_SETTINGS_SECTIONS) {
      const entry = command(`settings.${section}`);
      expect(entry.label).toBe(GLOBAL_SETTINGS_CATALOG[section].label);
      expect(entry.group).toBe("settings");
    }
  });

  test("mutations either ask first or cannot be harmful, and none runs typed text", () => {
    const mutations = COMMAND_CATALOG.filter((entry) => entry.effect === "mutation");
    for (const id of ["environment.start", "environment.stop"]) {
      expect(command(id).confirm).toBeDefined();
    }
    // The unconfirmed mutations are reversible window-local changes or a new tab.
    expect(
      mutations
        .filter((entry) => !entry.confirm)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([
      "app.clear-recent-commands",
      "app.forget-recent-commands",
      "app.remember-recent-commands",
      "environment.new-agent-tab",
    ]);
  });

  test("each command delegates to its owning action through the runtime", async () => {
    const calls: string[] = [];
    const runtime: CommandRuntime = {
      openEnvironment: (_target, options) =>
        calls.push(`openEnvironment:${options?.filesPanelTab ?? options?.dialog ?? ""}`),
      openProject: (_target, options) =>
        calls.push(
          `openProject:${options?.boardTab ?? options?.dialog ?? (options?.createEnvironment ? "create" : "")}`,
        ),
      openGlobalSettings: (section) => calls.push(`settings:${section}`),
      requestAppShortcut: (id) => calls.push(`shortcut:${id}`),
      environmentPower: async (action) => {
        calls.push(`power:${action}`);
      },
      addProject: () => calls.push("addProject"),
      copyText: () => calls.push("copy"),
      clearRecentCommands: () => calls.push("clearRecent"),
      setRememberRecentCommands: (remember) => calls.push(`remember:${remember}`),
    };
    const context = localContext();
    const expectations: Record<string, string> = {
      "environment.open-changes": "openEnvironment:changes",
      "environment.browse-files": "openEnvironment:all-files",
      "environment.new-agent-tab": "shortcut:new-agent-tab",
      "environment.start": "power:start",
      "environment.stop": "power:stop",
      "environment.rebuild": "openEnvironment:environment-rebuild",
      "environment.copy-id": "copy",
      "project.new-environment": "openProject:create",
      "project.open-home": "openProject:home",
      "project.open-coordinator": "openProject:coordinator",
      "project.open-kanban": "openProject:kanban",
      "project.open-github": "openProject:github",
      "app.add-project": "addProject",
      "app.keyboard-shortcuts": "shortcut:show-shortcuts",
      "app.sidebar-grouping": "shortcut:rotate-sidebar-grouping",
      "app.clear-recent-commands": "clearRecent",
      "app.remember-recent-commands": "remember:true",
      "app.forget-recent-commands": "remember:false",
      "settings.environment": "openEnvironment:environment-settings",
      "settings.repository": "openProject:repository-settings",
      "settings.previews": "settings:previews",
    };
    for (const [id, call] of Object.entries(expectations)) {
      calls.length = 0;
      const entry = command(id);
      await entry.run(commandTarget(entry, context), runtime);
      expect(calls).toEqual([call]);
    }
  });
});

describe("palette context", () => {
  test("names the frozen environment, project and its machine", () => {
    const context = localContext();
    expect(context.environment?.name).toBe("build-modal-steps");
    expect(context.project?.name).toBe("orkestrator-v2");
    expect(context.machine).toBeNull();
    expect(commandTarget(command("environment.stop"), context)).toEqual({
      machine: null,
      project: { id: "p-ork", name: "orkestrator-v2" },
      environment: { id: "e-box", name: "build-modal-steps", projectId: "p-ork" },
    });
  });

  test("resolves another machine's environment from that machine, never a local namesake", () => {
    const context = remoteContext();
    expect(context.machine?.name).toBe("mbp3");
    expect(context.environment?.remote?.machine.name).toBe("mbp3");
    const target = commandTarget(command("environment.stop"), context);
    expect(target.machine?.connectionId).toBe("bk_mbp3");
    expect(describeTargetMachine(target)).toBe("mbp3");
  });

  test("an offline machine keeps its environment but refuses commands that write", () => {
    const offline = { ...mbp3, transport: "unreachable" as const };
    const context = remoteContext(offline);
    expect(context.environment?.name).toBe("build-modal-steps");
    expect(commandAvailability(command("environment.open-changes"), context)).toEqual({
      available: true,
    });
    const stop = commandAvailability(command("environment.stop"), context);
    expect(stop).toMatchObject({ available: false, code: "machine-offline" });
    expect(commandAvailability(command("settings.environment"), context)).toMatchObject({
      available: false,
      code: "machine-offline",
      nextStep: { kind: "command", commandId: "settings.machines" },
    });
  });

  test("a target the offline machine has not reported is unknown, not deleted", () => {
    const offline = { ...mbp3, transport: "unreachable" as const };
    const context = remoteContext(offline, "never-reported");
    expect(context.environmentMissing).toBe(false);
    expect(context.targetUnknown).toBe(true);
    expect(commandAvailability(command("environment.open-changes"), context)).toMatchObject({
      available: false,
      code: "target-unknown",
    });
  });

  test("a deleted target is unavailable with a way to choose another, never a neighbour", () => {
    const context = localContext({
      selection: { nodeId: "bk_self", projectId: "p-ork", environmentId: "e-gone" },
    });
    expect(context.environment).toBeNull();
    expect(context.environmentMissing).toBe(true);
    expect(commandAvailability(command("environment.stop"), context)).toMatchObject({
      available: false,
      code: "target-missing",
      nextStep: { kind: "filter", filter: "environments" },
    });
  });

  test("no selection explains what to choose", () => {
    const context = localContext({
      selection: { nodeId: null, projectId: null, environmentId: null },
    });
    expect(commandAvailability(command("environment.open-changes"), context)).toMatchObject({
      available: false,
      reason: "Choose an environment first",
      nextStep: { kind: "filter", filter: "environments" },
    });
    expect(commandAvailability(command("project.new-environment"), context)).toMatchObject({
      available: false,
      reason: "Choose a project first",
    });
    expect(commandAvailability(command("app.keyboard-shortcuts"), context).available).toBe(true);
  });

  test("power commands follow the sidebar menu's rule and explain it", () => {
    const stop = command("environment.stop");
    const start = command("environment.start");
    const running = localContext();
    expect(stop.hidden?.(running)).toBe(false);
    expect(start.hidden?.(running)).toBe(true);
    expect(commandAvailability(stop, running).available).toBe(true);

    const busy = localContext({ pending: new Set(["e-box"]) });
    expect(commandAvailability(stop, busy)).toMatchObject({ available: false, code: "busy" });

    const noDocker = localContext({ dockerAvailable: false });
    // Without Docker the row reads the container as not running and offers Start.
    expect(start.hidden?.(noDocker)).toBe(false);
    expect(commandAvailability(start, noDocker)).toMatchObject({
      available: false,
      code: "docker-unavailable",
      nextStep: { kind: "command", commandId: "settings.docker" },
    });

    const creating = localContext({
      localEnvironments: [{ ...runningContainer, status: "creating" }],
    });
    expect(commandAvailability(start, creating)).toMatchObject({
      available: false,
      code: "transitioning",
    });
  });

  test("local environments have no container commands", () => {
    const context = localContext({
      selection: { nodeId: "bk_self", projectId: "p-ork", environmentId: localWorktree.id },
    });
    for (const id of ["environment.start", "environment.stop", "environment.rebuild"]) {
      expect(command(id).hidden?.(context)).toBe(true);
    }
  });

  test("New agent tab needs the frozen environment to still be the one shown", () => {
    const selection = { nodeId: "bk_self", projectId: "p-ork", environmentId: "e-box" };
    const moved = localContext({
      selection,
      shownSelection: { ...selection, environmentId: localWorktree.id },
    });
    expect(moved.selectionCurrent).toBe(false);
    // The frozen target is unchanged by what the window shows now.
    expect(moved.environment?.id).toBe("e-box");
    expect(commandAvailability(command("environment.new-agent-tab"), moved)).toMatchObject({
      available: false,
      code: "not-shown",
      nextStep: { kind: "refresh-context" },
    });
  });

  test("gated Settings sections are hidden until their flag is on", () => {
    const off = localContext();
    expect(command("settings.schedules").hidden?.(off)).toBe(true);
    const on = localContext({ settingsFlags: { experimentalScheduling: true } });
    expect(command("settings.schedules").hidden?.(on)).toBe(false);
  });

  test("a project home is named as the sidebar names it", () => {
    const home = environment({
      id: "e-home",
      projectId: "p-ork",
      name: "project-home",
      projectHome: true,
      environmentType: "local",
    });
    const context = localContext({
      selection: { nodeId: "bk_self", projectId: "p-ork", environmentId: "e-home" },
      localEnvironments: [home],
    });
    expect(context.environment?.name).toBe("Project home");
  });
});
