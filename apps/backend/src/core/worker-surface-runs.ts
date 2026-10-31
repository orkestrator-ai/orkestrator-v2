import {
  COORDINATOR_TAB_EDIT_OPERATIONS,
  COORDINATOR_TERMINAL_TAB_TYPES,
  type CoordinatorTabEditOperation,
  type CoordinatorTerminalTabType,
} from "@orkestrator/protocol/coordinator-surfaces";
import {
  formatPreviewIntentUri,
  parsePreviewUrlIntent,
} from "@orkestrator/protocol/preview-services";
import { buildTerminalAgentLaunchCommand } from "@orkestrator/protocol/terminal-agent-launch";
import { isTabTeardownKind, type TabTeardownKind } from "@orkestrator/protocol/tab-teardown";
import type { CommandContext } from "./commands-context.js";
import { asNonBlankString } from "./commands-helpers.js";
import type { Environment, NativeAgentProvider } from "./models.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";
import { editWorkerTab, openWorkerBrowserTab } from "./worker-tab-actions.js";
import { beginWorkerTabClose } from "./worker-tab-close-admission.js";

/**
 * The worker surfaces as they run on the node that owns the worker: a
 * terminal launch, a browser preview, a tab edit. A coordinator on this node
 * reaches them through `coordinator-surface-actions.ts`; a command node's
 * coordinator through the `*_controller_*` commands in
 * `commands-registry-controller-workflows.ts`. Each caller checks its own
 * scope and owns the receipt; these validate the input, refuse the project
 * home, and derive every ID from the key they are given, so a retry with the
 * same key finds what the first attempt made.
 */

type JsonRecord = Record<string, unknown>;

export type SurfaceCommandRunner = <T>(
  context: CommandContext,
  command: string,
  args: JsonRecord,
) => Promise<T>;

export function surfaceRecord(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Expected ${name}`);
  return value as JsonRecord;
}

export function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Expected ${name} of 1-${max} characters`);
  return value.trim();
}

/** A disposable worker of the project: never the checkout itself. */
export async function requireProjectWorker(
  context: CommandContext,
  projectId: string,
  environmentId: unknown,
): Promise<Environment> {
  const id = asNonBlankString(environmentId, "environmentId");
  const environment = await context.storage.getEnvironment(id);
  if (!environment || environment.projectId !== projectId)
    throw new Error("Environment not found in this project");
  if (isProjectHomeEnvironment(environment))
    throw new Error("Coordinator credential cannot act on the project checkout");
  if (environment.deletionRequestedAt || environment.lifecycleOperation === "deleting")
    throw new Error("The worker environment is being deleted");
  return environment;
}

/** A key the caller derived from its receipt; it becomes part of tab and request IDs. */
export function surfaceKey(value: unknown): string {
  const key = asNonBlankString(value, "key");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw new Error("Expected a surface key");
  return key;
}

export interface TerminalLaunch {
  type: CoordinatorTerminalTabType;
  command?: string;
  prompt?: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
}

export function parseTerminalLaunch(input: JsonRecord): TerminalLaunch {
  const tabType = input.tabType ?? "plain";
  if (!(COORDINATOR_TERMINAL_TAB_TYPES as readonly unknown[]).includes(tabType))
    throw new Error(`tabType must be one of ${COORDINATOR_TERMINAL_TAB_TYPES.join(", ")}`);
  const type = tabType as CoordinatorTerminalTabType;
  const command = optionalText(input.command, "command", 100_000);
  const prompt = optionalText(input.prompt, "prompt", 100_000);
  const title = optionalText(input.title, "title", 200);
  const model = optionalText(input.model, "model", 512);
  const reasoningEffort = optionalText(input.reasoningEffort, "reasoningEffort", 128);
  if (type === "plain" && !command) throw new Error("A plain terminal needs a command to run");
  if (type !== "plain" && command)
    throw new Error("command is for plain terminals; agent terminals take prompt and model");
  if (type === "plain" && (prompt || model || reasoningEffort))
    throw new Error("prompt, model and reasoningEffort are for agent terminals");
  if (type === "grok" && (prompt || model || reasoningEffort))
    throw new Error("grok terminals do not support prompt, model or reasoningEffort options");
  return { type, command, prompt, title, model, reasoningEffort };
}

/** `jobRequestId` names the job; `launch_terminal_job` reattaches to it on a retry. */
export async function launchWorkerTerminal(
  context: CommandContext,
  run: SurfaceCommandRunner,
  environmentId: string,
  launch: TerminalLaunch,
  jobRequestId: string,
): Promise<JsonRecord> {
  const { type, command, prompt, title, model, reasoningEffort } = launch;
  let data: string | undefined;
  if (type === "plain") data = `${command}\n`;
  else if (type !== "claude-tmux") {
    const line = buildTerminalAgentLaunchCommand({
      tabType: type,
      initialPrompt: prompt,
      model,
      reasoningEffort,
    });
    if (!line) throw new Error(`${type} does not support terminal launch`);
    data = `${line}\n`;
  }
  const launched = await run<JsonRecord>(context, "launch_terminal_job", {
    requestId: jobRequestId,
    environmentId,
    tabType: type,
    ...(title ? { title } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(type === "claude-tmux"
      ? {
          ...(prompt ? { initialPrompt: prompt } : {}),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        }
      : {}),
    activateTab: true,
  });
  return { environmentId, tabId: launched.tabId, tabType: type, status: launched.status };
}

export interface BrowserOpen {
  address: string;
  tabId?: string;
  title?: string;
}

export function parseBrowserOpen(input: JsonRecord, environmentId: string): BrowserOpen {
  const address = asNonBlankString(input.url, "url").trim();
  // The same rule the browser tab applies to an agent's link: a loopback
  // http(s) address of a service this worker runs, never the open web.
  parsePreviewUrlIntent(address, "agent-link", environmentId);
  return {
    address,
    tabId: optionalText(input.tabId, "tabId", 200),
    title: optionalText(input.title, "title", 200),
  };
}

export async function openWorkerBrowser(
  context: CommandContext,
  environmentId: string,
  open: BrowserOpen,
  key: string,
): Promise<JsonRecord> {
  const url = formatPreviewIntentUri({ environmentId, source: "agent-link", url: open.address });
  const ui = await openWorkerBrowserTab(context.storage, {
    environmentId,
    ...(open.tabId ? { tabId: open.tabId } : {}),
    newTabId: `browser-coordinator-${key}`,
    url,
    navigationRequestId: `coordinator-${key}`,
    ...(open.title ? { title: open.title } : {}),
  });
  return { environmentId, url: open.address, ui };
}

export interface TabEdit {
  tabId: string;
  operation: CoordinatorTabEditOperation;
  toPaneId?: string;
}

export function parseTabEdit(input: JsonRecord): TabEdit {
  const tabId = asNonBlankString(input.tabId, "tabId");
  const operation = input.operation;
  if (!(COORDINATOR_TAB_EDIT_OPERATIONS as readonly unknown[]).includes(operation))
    throw new Error(`operation must be one of ${COORDINATOR_TAB_EDIT_OPERATIONS.join(", ")}`);
  const toPaneId = optionalText(input.toPaneId, "toPaneId", 200);
  if (operation === "move" && !toPaneId) throw new Error("move needs toPaneId (see list_tabs)");
  return { tabId, operation: operation as CoordinatorTabEditOperation, toPaneId };
}

/**
 * Focus, move or close one tab. A close is refused while a coordinator on
 * this node waits on the tab's report or its native agent is busy; a command
 * node checks its own delegations before it calls this on the leaf.
 */
export async function editWorkerTabWithTeardown(
  context: CommandContext,
  run: SurfaceCommandRunner,
  environmentId: string,
  edit: TabEdit,
): Promise<JsonRecord> {
  const { tabId, operation, toPaneId } = edit;
  const close = async (tab: JsonRecord) => {
    const delegations = await context.storage.coordinators.listOpenCoordinatorDelegations();
    if (
      delegations.some(
        (association) =>
          association.kind === "environment" &&
          association.nodeId === undefined &&
          association.resourceId === environmentId &&
          association.delegation?.workerTabId === tabId,
      )
    )
      throw new Error("A coordinator is waiting on this tab's report; it cannot be closed now");
    const native = await nativeTurnPhase(context, environmentId, tab);
    if (native && native !== "idle" && native !== "error")
      throw new Error(
        "The agent in this tab is busy or waiting on a person; it cannot be closed now",
      );
    const kind = teardownKind(tab);
    if (kind) {
      // Retain the tab and resource identity until teardown succeeds. The
      // teardown command journals its own intent and retains conversation history.
      const sessionId =
        kind === "terminal"
          ? tab.backendTerminalSessionId
          : kind.endsWith("-native") &&
              !["claude-native", "codex-native", "opencode-native"].includes(kind)
            ? (tab.nativeAgentData as JsonRecord | undefined)?.sessionId
            : undefined;
      await run(context, "teardown_tab", {
        environmentId,
        tabId,
        kind,
        ...(typeof sessionId === "string" ? { sessionId } : {}),
      });
    }
  };
  const release = operation === "close" ? beginWorkerTabClose(environmentId, tabId) : () => {};
  let releaseAgentAdmission: (() => void) | undefined;
  try {
    if (operation === "close")
      releaseAgentAdmission = context.runtime.environments.fence.beginTabClose(environmentId);
    const edited = await editWorkerTab(context.storage, {
      environmentId,
      tabId,
      operation,
      ...(toPaneId ? { toPaneId } : {}),
      beforeClose: close,
    });
    const { closed: _closed, ...result } = edited;
    return { environmentId, ...result };
  } finally {
    releaseAgentAdmission?.();
    release();
  }
}

/** Which `teardown_tab` kind closes a tab's resources, if it owns any. */
function teardownKind(tab: JsonRecord): TabTeardownKind | null {
  if (tab.type === "claude-tmux") return "claude-tmux";
  if (tab.type === "agent-native") {
    const data = tab.nativeAgentData as JsonRecord | undefined;
    const kind = `${String(data?.platform)}-native`;
    return isTabTeardownKind(kind) ? kind : null;
  }
  return typeof tab.type === "string" &&
    ["plain", "root", "claude", "codex", "cursor", "grok", "opencode", "pi"].includes(tab.type)
    ? "terminal"
    : null;
}

async function nativeTurnPhase(
  context: CommandContext,
  environmentId: string,
  tab: JsonRecord,
): Promise<string | null> {
  const platform = (tab.nativeAgentData as JsonRecord | undefined)?.platform;
  if (tab.type !== "agent-native") return null;
  if (typeof platform !== "string" || !context.nativeAgents) return "unknown";
  try {
    const projection = await context.nativeAgents.getProjection({
      environmentId,
      agent: platform as NativeAgentProvider,
      logicalSessionKey: `env-${environmentId}:${String(tab.id)}`,
      messageLimit: 1,
    });
    if (!projection) return null;
    if (projection.interactions.length > 0) return "waiting";
    return projection.turn.phase;
  } catch {
    // An unreadable session is refused rather than closed under a turn.
    return "unknown";
  }
}
