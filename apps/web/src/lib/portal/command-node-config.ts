/**
 * Config layering (report §9, plan item 3005): a node's own machine settings
 * under the command node's inherited preferences.
 *
 * Every read and save here names its two nodes explicitly, as `ConfigTargets`:
 * the command node, which owns the inherited preferences
 * (`INHERITED_GLOBAL_SETTING_KEYS`), and the machine whose own settings are
 * shown, or `null` when that machine is the command node itself.
 *
 * Scopes say which two nodes those are. A node scope's settings parent
 * (`settingsParent`) is the scope its inherited preferences come from: a
 * leaf scope's is its window's command scope, and a command scope has none.
 * `configTargetsForScopes(scope, commandScope)` turns two scopes into targets,
 * and `configTargetsFor(scope)` uses the scope's settings parent.
 */
import {
  INHERITED_GLOBAL_SETTING_KEYS,
  pickInheritedGlobalSettings,
} from "@orkestrator/protocol/controller-settings";
import {
  firstEnabledAgentPlatform,
  normalizeAgentPlatforms,
} from "@orkestrator/protocol/agent-platforms";
import { normalizeAgentSettings } from "@orkestrator/protocol/agent-settings";
import { CONFIG_COMMANDS } from "@orkestrator/protocol/contract/domains/config";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import type {
  GlobalSettingSources,
  ResetSettingExpectation,
} from "@orkestrator/protocol/setting-sources";
import { config as configDomain } from "@/lib/node-scope/domains/config";
import type { BackendId } from "@orkestrator/protocol/federation";
import { deepEqualJson } from "@/lib/chat/message-identity";
import { scopeBackendClient, type BackendClient } from "@/lib/backend/client";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope } from "@/lib/node-scope-slots";
import type { AppConfig, GlobalConfig } from "@/types";
import { portalStore } from "./portal-store";
import { commandScopeBackendClient } from "./command-scope";

/** The two nodes one config read or save involves. */
export interface ConfigTargets {
  /** The command node: inherited preferences are read from and saved to it. */
  readonly commandNode: BackendClient;
  /**
   * The machine whose own settings these are. `null`: the command node
   * itself, so nothing is split or layered.
   */
  readonly node: BackendClient | null;
}

/** What a config command left on each node, and the effective view of both. */
export interface ConfigCommandResult {
  /** `node`'s settings with the command node's inherited preferences laid over. */
  readonly config: AppConfig;
  /** The command node's config, as saved or as read alongside the command. */
  readonly commandNode: AppConfig;
  /** The machine's own config, as saved or read; `null` when the targets have no separate machine. */
  readonly node: AppConfig | null;
}

/** Where a scope's inherited preferences come from. */
export interface SettingsParent {
  /** The command node's scope; its own sync keeps its config store current. */
  readonly scope: NodeScope;
  /** The command node's commands. */
  readonly client: BackendClient;
}

const PATCH_GLOBAL_CONFIG = "patch_global_config";

type ConfigInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const CONFIG_COMMAND_NAMES: ReadonlySet<string> = new Set(CONFIG_COMMANDS.map((def) => def.name));

type ConfigCommandCalls = Readonly<Record<string, (args: unknown) => Promise<unknown>>>;

/**
 * `client`'s command call. A `config` command goes through the domain client
 * (plan item 7005): version 1 for a node that advertises the domain, with the
 * envelope and the open settings records decoded (every key kept); today's
 * call otherwise. Anything else (a command node setting another domain owns)
 * is today's call. A call without arguments stays a one-argument call.
 */
function sender(client: BackendClient): ConfigInvoke {
  const config = configDomain(client);
  return <T>(command: string, args?: Record<string, unknown>) => {
    if (CONFIG_COMMAND_NAMES.has(command)) {
      const call = (config() as unknown as ConfigCommandCalls)[command]!;
      return call(args ?? {}) as Promise<T>;
    }
    return args === undefined ? client.invokeRaw<T>(command) : client.invokeRaw<T>(command, args);
  };
}

/**
 * The effective view of a machine: its own settings, with the command node's
 * inherited preferences in place of its own copies, and the default agent
 * coerced to one the machine has enabled.
 */
export function layerConfig(commandNode: AppConfig, node: AppConfig): AppConfig {
  const global = { ...node.global };
  for (const key of INHERITED_GLOBAL_SETTING_KEYS) delete global[key];
  Object.assign(global, pickInheritedGlobalSettings(commandNode.global));
  const agentSettings = normalizeAgentSettings(global.agentSettings);
  const enabled = normalizeAgentPlatforms(global.enabledAgentPlatforms, []);
  global.agentSettings = {
    ...agentSettings,
    defaultAgent:
      enabled.length > 0
        ? firstEnabledAgentPlatform(enabled, agentSettings.defaultAgent)
        : agentSettings.defaultAgent,
  };
  return { ...node, global };
}

/** Patch one node's global settings; an empty patch reads them instead. */
async function patchGlobalOnNode(
  nodeInvoke: ConfigInvoke,
  patchValue: unknown,
  unsetValue: unknown,
): Promise<AppConfig> {
  const patch = (patchValue ?? {}) as Partial<GlobalConfig>;
  const unset = Array.isArray(unsetValue) ? (unsetValue as string[]) : [];
  if (Object.keys(patch).length === 0 && unset.length === 0) {
    return nodeInvoke<AppConfig>("get_config");
  }
  return nodeInvoke<AppConfig>(PATCH_GLOBAL_CONFIG, {
    patch,
    ...(unset.length > 0 ? { unset } : {}),
  });
}

/**
 * Route a patch: inherited preferences go to the command node, everything
 * else to the machine. Only the keys the user changed travel, so neither
 * node's other settings are rewritten from this window's copy.
 */
async function splitGlobalPatch(
  args: Record<string, unknown> | undefined,
  commandInvoke: ConfigInvoke,
  nodeInvoke: ConfigInvoke,
): Promise<ConfigCommandResult> {
  const patch = { ...(args?.patch as Partial<GlobalConfig> | undefined) };
  const unset = Array.isArray(args?.unset) ? (args.unset as string[]) : [];
  const inherited = new Set<string>(INHERITED_GLOBAL_SETTING_KEYS);
  const commandPatch: Record<string, unknown> = {};
  const nodePatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    (inherited.has(key) ? commandPatch : nodePatch)[key] = value;
  }
  if (patch.agentSettings) {
    // The form shows the default agent coerced to one enabled on this
    // machine. Echoing that coerced value must not move the command node's.
    const [commandNode, node] = await Promise.all([
      commandInvoke<AppConfig>("get_config"),
      nodeInvoke<AppConfig>("get_config"),
    ]);
    const effective = layerConfig(commandNode, node).global;
    if (patch.agentSettings.defaultAgent === effective.agentSettings?.defaultAgent) {
      commandPatch.agentSettings = {
        ...patch.agentSettings,
        defaultAgent: commandNode.global.agentSettings?.defaultAgent,
      };
    }
  }
  const savedCommand = await patchGlobalOnNode(
    commandInvoke,
    commandPatch,
    unset.filter((key) => inherited.has(key)),
  );
  const savedNode = await patchGlobalOnNode(
    nodeInvoke,
    nodePatch,
    unset.filter((key) => !inherited.has(key)),
  );
  return layered(savedCommand, savedNode);
}

function layered(commandNode: AppConfig, node: AppConfig): ConfigCommandResult {
  return { config: layerConfig(commandNode, node), commandNode, node };
}

/** Replace both nodes' globals from one effective object, each node getting its own keys. */
async function splitGlobalUpdate(
  args: Record<string, unknown> | undefined,
  commandInvoke: ConfigInvoke,
  nodeInvoke: ConfigInvoke,
): Promise<ConfigCommandResult> {
  // Read before writing: a failed paired read must not leave a partial save.
  const [commandNode, node] = await Promise.all([
    commandInvoke<AppConfig>("get_config"),
    nodeInvoke<AppConfig>("get_config"),
  ]);
  const incoming = args?.global as GlobalConfig;
  const effective = layerConfig(commandNode, node).global;
  const commandGlobal = { ...commandNode.global };
  const nodeGlobal = { ...incoming };
  for (const key of INHERITED_GLOBAL_SETTING_KEYS) {
    // Preserve command defaults when the form echoes a machine-coerced value.
    if (!deepEqualJson(incoming[key], effective[key])) {
      delete commandGlobal[key];
      if (incoming[key] !== undefined) Object.assign(commandGlobal, { [key]: incoming[key] });
      if (
        key === "agentSettings" &&
        incoming.agentSettings?.defaultAgent === effective.agentSettings?.defaultAgent
      ) {
        commandGlobal.agentSettings = {
          ...incoming.agentSettings,
          defaultAgent: commandNode.global.agentSettings?.defaultAgent,
        };
      }
    }
    delete nodeGlobal[key];
  }
  const savedCommand = await commandInvoke<AppConfig>("update_global_config", {
    global: commandGlobal,
  });
  const savedNode = await nodeInvoke<AppConfig>("update_global_config", {
    global: nodeGlobal,
    preserveInheritedSettings: true,
  });
  return layered(savedCommand, savedNode);
}

/**
 * Run one config command against `targets` and report what each node holds
 * afterwards.
 *
 * With no separate machine the command goes to the command node as it is
 * (a patch through `patchGlobalOnNode`). Otherwise a global patch or update
 * is split by key, inherited preferences to the command node and machine
 * settings to the machine, and any other command (a read, a repository
 * setting, a credential) runs on the machine with the command node's config
 * read beside it, so the answer is the effective view.
 */
export async function runConfigCommandLayers(
  targets: ConfigTargets,
  command: string,
  args?: Record<string, unknown>,
): Promise<ConfigCommandResult> {
  const commandInvoke = sender(targets.commandNode);
  if (!targets.node) {
    const config =
      command === PATCH_GLOBAL_CONFIG
        ? await patchGlobalOnNode(commandInvoke, args?.patch, args?.unset)
        : await commandInvoke<AppConfig>(command, args);
    return { config, commandNode: config, node: null };
  }
  const nodeInvoke = sender(targets.node);
  if (command === PATCH_GLOBAL_CONFIG) return splitGlobalPatch(args, commandInvoke, nodeInvoke);
  if (command === "update_global_config") return splitGlobalUpdate(args, commandInvoke, nodeInvoke);
  const [commandNode, node] = await Promise.all([
    commandInvoke<AppConfig>("get_config"),
    nodeInvoke<AppConfig>(command, args),
  ]);
  return layered(commandNode, node);
}

/** `runConfigCommandLayers`, answering only the effective view. */
export async function runConfigCommand(
  targets: ConfigTargets,
  command: string,
  args?: Record<string, unknown>,
): Promise<AppConfig> {
  return (await runConfigCommandLayers(targets, command, args)).config;
}

/** A command dedicated to inherited preferences: it always runs on the command node. */
export function runCommandNodeSetting<T>(
  targets: ConfigTargets,
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return sender(targets.commandNode)<T>(command, args);
}

// ── Settings parents ────────────────────────────────────────────────────────

const boundParents = new WeakMap<NodeScope, NodeScope | null>();

/**
 * Says explicitly which scope `scope` inherits preferences from (`null`:
 * none). Call it before `scope`'s config store is first read, which wires the
 * inheritance once. Scopes the app window opens need no binding (see
 * `settingsParent`); a test's own window scope binds its leaves.
 */
export function bindSettingsParent(scope: NodeScope, parent: NodeScope | null): void {
  boundParents.set(scope, parent === scope ? null : parent);
}

function scopeParent(parent: NodeScope): SettingsParent {
  return { scope: parent, client: scopeBackendClient(parent) };
}

/**
 * Where `scope`'s inherited preferences come from, or `null` when `scope` is
 * the command node and its own settings are the effective ones.
 *
 * A binding (`bindSettingsParent`) wins. Otherwise a leaf scope of the app
 * window inherits from that window's command scope. Any other scope has no
 * parent.
 */
export function settingsParent(scope: NodeScope): SettingsParent | null {
  if (boundParents.has(scope)) {
    const bound = boundParents.get(scope);
    return bound ? scopeParent(bound) : null;
  }
  if (scope.role === "leaf") {
    const windowScope = getWindowScope();
    return windowScope.get(scope.nodeId) === scope ? scopeParent(windowScope.commandScope()) : null;
  }
  return null;
}

/** Targets for `scope`'s settings under `commandScope`'s preferences; no split when they are one scope. */
export function configTargetsForScopes(
  scope: NodeScope,
  commandScope: NodeScope | null,
): ConfigTargets {
  if (!commandScope || commandScope === scope) {
    return { commandNode: scopeBackendClient(scope), node: null };
  }
  return { commandNode: scopeBackendClient(commandScope), node: scopeBackendClient(scope) };
}

/** Targets for `scope`'s settings under its settings parent. */
export function configTargetsFor(scope: NodeScope): ConfigTargets {
  const parent = settingsParent(scope);
  if (!parent) return { commandNode: scopeBackendClient(scope), node: null };
  return { commandNode: parent.client, node: scopeBackendClient(scope) };
}

// ── The command-bound shim (`@/lib/backend` config functions) ──────────────

/** Another machine, reached through the command node. */
function routedNodeClient(node: BackendId): BackendClient {
  return {
    invokeRaw: <T>(command: string, args?: Readonly<Record<string, unknown>>) =>
      portalStore.invokeOnNode<T>(node, command, (args ?? {}) as Record<string, unknown>),
  };
}

/**
 * Read the effective config, or save each setting on its owning node, for
 * the app window's command scope or a machine picked in Settings.
 *
 * `machine` names the node whose machine settings are shown, as Settings
 * does for the machine picked in its header: `null` is the command node
 * itself, a node ID another machine reached through it, and `undefined` the
 * window's command scope under its settings parent (`configTargetsFor`).
 */
export async function invokeGlobalConfigCommand(
  command: string,
  args?: Record<string, unknown>,
  machine?: string | null,
): Promise<AppConfig> {
  return runConfigCommand(machineTargets(machine), command, args);
}

export async function invokeRepositoryConfigCommand(
  command: string,
  args?: Record<string, unknown>,
): Promise<AppConfig> {
  return invokeGlobalConfigCommand(command, args);
}

/** Commands dedicated to inherited preferences target the app window's command node. */
export function invokeCommandNodeSetting<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return runCommandNodeSetting<T>(configTargetsFor(appCommandScope()), command, args);
}

// ── Setting sources and guarded resets (Settings search, field explanations) ─

const GET_GLOBAL_SETTING_SOURCES = "get_global_setting_sources";
const RESET_GLOBAL_SETTINGS = "reset_global_settings";

/** One node's answer to the sources read. */
export type SettingSourcesRead =
  | { readonly status: "ok"; readonly sources: GlobalSettingSources }
  /** The node predates the command: where a value comes from is unknown. */
  | { readonly status: "unsupported" }
  | { readonly status: "failed"; readonly message: string };

/**
 * The sources of both nodes a settings view involves: the command node, whose
 * stored preferences every machine inherits, and the machine itself (`null`
 * when the machine is the command node).
 */
export interface SettingSourcesLayers {
  readonly commandNode: SettingSourcesRead;
  readonly node: SettingSourcesRead | null;
}

async function readSources(invoke: ConfigInvoke): Promise<SettingSourcesRead> {
  try {
    return {
      status: "ok",
      sources: await invoke<GlobalSettingSources>(GET_GLOBAL_SETTING_SOURCES, {}),
    };
  } catch (error) {
    if (incompatibility(error, GET_GLOBAL_SETTING_SOURCES)?.code === "unknown-command") {
      return { status: "unsupported" };
    }
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function readSettingSourcesLayers(
  targets: ConfigTargets,
): Promise<SettingSourcesLayers> {
  const [commandNode, node] = await Promise.all([
    readSources(sender(targets.commandNode)),
    targets.node ? readSources(sender(targets.node)) : Promise.resolve(null),
  ]);
  return { commandNode, node };
}

/** A guarded reset's outcome; `config` is the effective view after it. */
export interface ResetSettingsOutcome {
  readonly status: "reset" | "conflict";
  /** Keys whose stored value moved since the preview; nothing was removed. */
  readonly conflicts: string[];
  readonly config: AppConfig;
}

interface ResetAnswer {
  status: "reset" | "conflict";
  conflicts: string[];
  config: AppConfig;
}

/**
 * Remove stored settings on the node that owns each: inherited preferences on
 * the command node, everything else on the machine. A conflict on the first
 * node stops before the second is touched, so nothing is removed on one node
 * on the strength of a preview the other has already contradicted.
 */
export async function runResetGlobalSettings(
  targets: ConfigTargets,
  keys: readonly string[],
  expectations: readonly ResetSettingExpectation[],
): Promise<ResetSettingsOutcome> {
  const inherited = new Set<string>(INHERITED_GLOBAL_SETTING_KEYS);
  const commandInvoke = sender(targets.commandNode);
  const groups: Array<{ invoke: ConfigInvoke; keys: string[] }> = targets.node
    ? [
        { invoke: commandInvoke, keys: keys.filter((key) => inherited.has(key)) },
        { invoke: sender(targets.node), keys: keys.filter((key) => !inherited.has(key)) },
      ]
    : [{ invoke: commandInvoke, keys: [...keys] }];
  let commandConfig: AppConfig | null = null;
  let nodeConfig: AppConfig | null = null;
  for (const [index, group] of groups.entries()) {
    if (group.keys.length === 0) continue;
    const answer = await group.invoke<ResetAnswer>(RESET_GLOBAL_SETTINGS, {
      keys: group.keys,
      expect: expectations.filter((entry) => group.keys.includes(entry.key)),
    });
    if (index === 0) commandConfig = answer.config;
    else nodeConfig = answer.config;
    if (answer.status === "conflict") {
      return {
        status: "conflict",
        conflicts: answer.conflicts,
        config: await effectiveAfter(targets, commandConfig, nodeConfig),
      };
    }
  }
  return {
    status: "reset",
    conflicts: [],
    config: await effectiveAfter(targets, commandConfig, nodeConfig),
  };
}

async function effectiveAfter(
  targets: ConfigTargets,
  commandConfig: AppConfig | null,
  nodeConfig: AppConfig | null,
): Promise<AppConfig> {
  if (!targets.node)
    return commandConfig ?? (await sender(targets.commandNode)<AppConfig>("get_config"));
  const [commandNode, node] = await Promise.all([
    commandConfig ?? sender(targets.commandNode)<AppConfig>("get_config"),
    nodeConfig ?? sender(targets.node)<AppConfig>("get_config"),
  ]);
  return layerConfig(commandNode, node);
}

/** `invokeGlobalConfigCommand`'s targets for `machine`. */
function machineTargets(machine?: string | null): ConfigTargets {
  if (machine === null || machine === portalStore.getState().selfId) {
    return { commandNode: commandScopeBackendClient, node: null };
  }
  if (machine !== undefined) {
    return { commandNode: commandScopeBackendClient, node: routedNodeClient(machine as BackendId) };
  }
  return configTargetsFor(appCommandScope());
}

/** Where `machine`'s settings come from, as Settings shows it. */
export function invokeSettingSources(machine?: string | null): Promise<SettingSourcesLayers> {
  return readSettingSourcesLayers(machineTargets(machine));
}

/** Reset settings for `machine`, each on the node that owns it. */
export function invokeResetGlobalSettings(
  keys: readonly string[],
  expectations: readonly ResetSettingExpectation[],
  machine?: string | null,
): Promise<ResetSettingsOutcome> {
  return runResetGlobalSettings(machineTargets(machine), keys, expectations);
}
