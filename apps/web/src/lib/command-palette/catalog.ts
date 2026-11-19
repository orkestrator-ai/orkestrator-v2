/**
 * Every command the ⌘K palette offers. Each one names the app action it
 * delegates to (through `CommandRuntime`) and the menu or shortcut that owns
 * that action, so a palette entry cannot drift from the surface it mirrors:
 *
 * - Environment power (Start/Stop/Restart): the sidebar row's menu
 *   (`environmentRowMenuItems`), same handlers, same disabled rule.
 * - Environment settings and Rebuild: the row's Settings item and the
 *   container section of the same dialog (`openMachineWorkspace` dialogs).
 * - Open changes / Browse files: the Files panel's own tabs.
 * - New environment, Repository settings, project board tabs: the project
 *   header's menu and board tabs (`openMachineWorkspace`).
 * - New agent tab, Keyboard shortcuts, Sidebar grouping: the app shortcuts
 *   (`requestAppShortcut`), so the palette and the key run one handler.
 * - Settings sections: `GLOBAL_SETTINGS_CATALOG`, opened through
 *   `requestGlobalSettings` like every other link into Settings.
 */
import {
  AVAILABLE,
  environmentPowerAvailability,
  type CommandDescriptor,
  type PaletteContext,
} from "./model";
import { GLOBAL_SETTINGS_CATALOG, isGlobalSettingsSectionEnabled } from "@/lib/settings-catalog";
import { GLOBAL_SETTINGS_SECTIONS } from "@/lib/settings-navigation";

const isLocalEnvironment = (context: PaletteContext) => context.environment?.isLocal === true;

const ENVIRONMENT_COMMANDS: readonly CommandDescriptor[] = [
  {
    id: "environment.open-changes",
    label: "Open changes",
    aliases: ["diff", "changed files", "review changes", "git changes", "files panel"],
    group: "actions",
    effect: "navigation",
    requires: "environment",
    suggested: true,
    run: (target, runtime) => runtime.openEnvironment(target, { filesPanelTab: "changes" }),
  },
  {
    id: "environment.browse-files",
    label: "Browse files",
    aliases: ["all files", "file tree", "explorer"],
    group: "actions",
    effect: "navigation",
    requires: "environment",
    run: (target, runtime) => runtime.openEnvironment(target, { filesPanelTab: "all-files" }),
  },
  {
    id: "environment.new-agent-tab",
    label: "New agent tab",
    aliases: ["new tab", "new session", "agent", "chat"],
    group: "actions",
    effect: "mutation",
    requires: "environment",
    // A tab is opened in the shown workspace by the ⌘T handler; it opens
    // nothing that cannot be closed again, so it asks no confirmation.
    needsLiveMachine: false,
    suggested: true,
    availability: (context) =>
      context.selectionCurrent
        ? AVAILABLE
        : {
            available: false,
            reason: "The window now shows another environment",
            code: "not-shown",
            nextStep: { kind: "refresh-context", label: "Use the environment now shown" },
          },
    shortcut: "new-agent-tab",
    run: (_target, runtime) => runtime.requestAppShortcut("new-agent-tab"),
  },
  {
    id: "environment.start",
    label: "Start environment",
    aliases: ["start container", "boot", "run", "power on"],
    group: "actions",
    effect: "mutation",
    requires: "environment",
    suggested: true,
    confirm: { title: "Start this environment?", verb: "Start" },
    // The row's menu offers Start only for a container that is not running.
    hidden: (context) =>
      isLocalEnvironment(context) || context.environment?.model.isRunning === true,
    availability: (context) =>
      !context.handlers.environmentPower
        ? {
            available: false,
            reason: "Starting is not available from this view",
            code: "handler-missing",
          }
        : context.environment
          ? environmentPowerAvailability(context.environment, "power")
          : AVAILABLE,
    run: (target, runtime) => runtime.environmentPower("start", target),
  },
  {
    id: "environment.stop",
    label: "Stop environment",
    aliases: ["stop container", "shut down", "power off", "halt"],
    group: "actions",
    effect: "mutation",
    requires: "environment",
    suggested: true,
    confirm: { title: "Stop this environment?", verb: "Stop" },
    hidden: (context) =>
      isLocalEnvironment(context) ||
      (context.environment !== null && !context.environment.model.isRunning),
    availability: (context) =>
      !context.handlers.environmentPower
        ? {
            available: false,
            reason: "Stopping is not available from this view",
            code: "handler-missing",
          }
        : context.environment
          ? environmentPowerAvailability(context.environment, "power")
          : AVAILABLE,
    run: (target, runtime) => runtime.environmentPower("stop", target),
  },
  {
    id: "environment.restart",
    label: "Restart environment",
    aliases: ["restart container", "reboot", "reload"],
    group: "actions",
    effect: "mutation",
    requires: "environment",
    confirm: { title: "Restart this environment?", verb: "Restart" },
    hidden: isLocalEnvironment,
    availability: (context) =>
      !context.handlers.environmentPower
        ? {
            available: false,
            reason: "Restarting is not available from this view",
            code: "handler-missing",
          }
        : context.environment
          ? environmentPowerAvailability(context.environment, "restart")
          : AVAILABLE,
    run: (target, runtime) => runtime.environmentPower("restart", target),
  },
  {
    id: "environment.rebuild",
    label: "Rebuild container (keep work)",
    aliases: ["rebuild", "recreate container", "new image"],
    group: "actions",
    // Opens the container settings, whose Rebuild asks its own confirmation.
    effect: "navigation",
    requires: "environment",
    needsLiveMachine: true,
    hidden: isLocalEnvironment,
    run: (target, runtime) => runtime.openEnvironment(target, { dialog: "environment-rebuild" }),
  },
  {
    id: "environment.copy-id",
    label: "Copy environment ID",
    aliases: ["id", "identifier", "copy"],
    group: "actions",
    effect: "read",
    requires: "environment",
    run: (target, runtime) => {
      if (target.environment) runtime.copyText(target.environment.id, "Copied environment ID");
    },
  },
];

const PROJECT_COMMANDS: readonly CommandDescriptor[] = [
  {
    id: "project.new-environment",
    label: "New environment",
    aliases: ["create environment", "worktree", "container", "branch", "fork"],
    group: "actions",
    // Opens the project's New Environment dialog, which asks for everything.
    effect: "navigation",
    requires: "project",
    needsLiveMachine: true,
    suggested: true,
    run: (target, runtime) => runtime.openProject(target, { createEnvironment: true }),
  },
  {
    id: "project.open-home",
    label: "Open project home",
    aliases: ["home", "overview", "project"],
    group: "actions",
    effect: "navigation",
    requires: "project",
    run: (target, runtime) => runtime.openProject(target, { boardTab: "home" }),
  },
  {
    id: "project.open-coordinator",
    label: "Open coordinator",
    aliases: ["coordinator", "orchestrate", "plan"],
    group: "actions",
    effect: "navigation",
    requires: "project",
    run: (target, runtime) => runtime.openProject(target, { boardTab: "coordinator" }),
  },
  {
    id: "project.open-kanban",
    label: "Open Kanban board",
    aliases: ["kanban", "tickets", "board", "tasks", "todo"],
    group: "actions",
    effect: "navigation",
    requires: "project",
    run: (target, runtime) => runtime.openProject(target, { boardTab: "kanban" }),
  },
  {
    id: "project.open-github",
    label: "Open GitHub issues and pull requests",
    aliases: ["github", "issues", "pull requests", "prs"],
    group: "actions",
    effect: "navigation",
    requires: "project",
    run: (target, runtime) => runtime.openProject(target, { boardTab: "github" }),
  },
];

const WINDOW_COMMANDS: readonly CommandDescriptor[] = [
  {
    id: "app.add-project",
    label: "Add project",
    aliases: ["new project", "clone", "repository", "import"],
    group: "actions",
    effect: "navigation",
    requires: "window",
    availability: (context) =>
      context.handlers.addProject
        ? AVAILABLE
        : {
            available: false,
            reason: "Adding a project is not available from this view",
            code: "handler-missing",
          },
    run: (_target, runtime) => runtime.addProject(),
  },
  {
    id: "app.keyboard-shortcuts",
    label: "Show keyboard shortcuts",
    aliases: ["shortcuts", "keybindings", "hotkeys", "help"],
    group: "actions",
    effect: "navigation",
    requires: "window",
    shortcut: "show-shortcuts",
    run: (_target, runtime) => runtime.requestAppShortcut("show-shortcuts"),
  },
  {
    id: "app.sidebar-grouping",
    label: "Change sidebar grouping",
    aliases: ["group by", "sidebar view", "activity", "machines view"],
    group: "actions",
    effect: "navigation",
    requires: "window",
    shortcut: "rotate-sidebar-grouping",
    run: (_target, runtime) => runtime.requestAppShortcut("rotate-sidebar-grouping"),
  },
  {
    id: "app.clear-recent-commands",
    label: "Clear recent commands",
    aliases: ["forget", "history", "recent"],
    group: "actions",
    effect: "mutation",
    requires: "window",
    availability: (context) =>
      context.recentCommandCount > 0
        ? AVAILABLE
        : { available: false, reason: "No recent commands", code: "nothing-to-clear" },
    run: (_target, runtime) => runtime.clearRecentCommands(),
  },
  {
    id: "app.remember-recent-commands",
    label: "Remember recent commands",
    aliases: ["recent", "history", "privacy"],
    group: "actions",
    effect: "mutation",
    requires: "window",
    hidden: (context) => context.rememberRecentCommands,
    run: (_target, runtime) => runtime.setRememberRecentCommands(true),
  },
  {
    id: "app.forget-recent-commands",
    label: "Stop remembering recent commands",
    aliases: ["recent", "history", "privacy", "forget"],
    group: "actions",
    effect: "mutation",
    requires: "window",
    hidden: (context) => !context.rememberRecentCommands,
    run: (_target, runtime) => runtime.setRememberRecentCommands(false),
  },
];

const SCOPED_SETTINGS: readonly CommandDescriptor[] = [
  {
    id: "settings.environment",
    label: "Environment settings",
    aliases: ["environment options", "ports", "network policy", "resources", "environment"],
    group: "settings",
    effect: "navigation",
    requires: "environment",
    // The sidebar row's Settings item is disabled while the machine is offline.
    needsLiveMachine: true,
    run: (target, runtime) => runtime.openEnvironment(target, { dialog: "environment-settings" }),
  },
  {
    id: "settings.repository",
    label: "Repository settings",
    aliases: ["project settings", "setup commands", "default branch", "repository"],
    group: "settings",
    effect: "navigation",
    requires: "project",
    needsLiveMachine: true,
    run: (target, runtime) => runtime.openProject(target, { dialog: "repository-settings" }),
  },
];

/** Settings → <section>, one per section of `GLOBAL_SETTINGS_CATALOG`. */
const GLOBAL_SETTINGS: readonly CommandDescriptor[] = GLOBAL_SETTINGS_SECTIONS.map(
  (section): CommandDescriptor => {
    const entry = GLOBAL_SETTINGS_CATALOG[section];
    return {
      id: `settings.${section}`,
      label: entry.label,
      aliases: ["settings", ...entry.aliases],
      group: "settings",
      effect: "navigation",
      requires: "window",
      hidden: (context) => !isGlobalSettingsSectionEnabled(section, context.settingsFlags),
      run: (_target, runtime) => runtime.openGlobalSettings(section),
    };
  },
);

export const COMMAND_CATALOG: readonly CommandDescriptor[] = [
  ...ENVIRONMENT_COMMANDS,
  ...PROJECT_COMMANDS,
  ...WINDOW_COMMANDS,
  ...SCOPED_SETTINGS,
  ...GLOBAL_SETTINGS,
];

const COMMANDS_BY_ID = new Map(COMMAND_CATALOG.map((command) => [command.id, command]));

export function commandById(id: string): CommandDescriptor | undefined {
  return COMMANDS_BY_ID.get(id);
}
