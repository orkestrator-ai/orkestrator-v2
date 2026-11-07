/**
 * Topology and page helpers for the multi-node window qualification (plan
 * item 4006, `multi-node-window.spec.ts`).
 *
 * The topology is two running `dev:test` profiles (the command node and its
 * first leaf, attached with `add_node` as in plan item 2013's proof) plus up
 * to five standalone leaves this process starts from source
 * (`electron-leaf-backend.ts`: temporary data directories, loopback, private
 * random tokens) and attaches to the command node. Tokens stay in this
 * process's memory and are used only as bearers; none is printed, written or
 * handed to a page.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Locator, Page } from "@playwright/test";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

import { startLeaf } from "./electron-leaf-backend";
import {
  attachLeaf,
  createLeafEnvironment,
  gateway,
  repositoryRoot,
  type Gateway,
} from "./scope-proof-support";

export const commandProfile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "";
export const leafProfile = process.env.ORKESTRATOR_AGENT_TEST_LEAF_PROFILE ?? "";
export const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? (commandProfile || "multi-node");
/** Standalone leaves started beside the leaf profile (default 5: six leaves in all). */
export const extraLeafCount = Math.max(
  0,
  Math.min(5, Number(process.env.ORKESTRATOR_AGENT_TEST_EXTRA_LEAVES ?? 5)),
);
export const evidenceDir = path.join(
  repositoryRoot,
  "output",
  "agent-testing",
  runId,
  "multi-node",
);

export const SKIP_REASON =
  "Set ORKESTRATOR_AGENT_TEST_PROFILE and ORKESTRATOR_AGENT_TEST_LEAF_PROFILE to two running dev:test profiles.";

/** One node of the topology, with the environment the flows use on it. */
export interface TopologyNode {
  readonly name: string;
  readonly nodeId: string;
  readonly origin: string;
  readonly environment: { id: string; name: string };
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface Topology {
  readonly command: TopologyNode & { gateway: Gateway };
  /** The leaf profile first, then the standalone leaves. */
  readonly leaves: TopologyNode[];
  stop(): Promise<void>;
}

/** The terminal tab every flow environment shows first. */
export const SHELL_TAB = "tab-shell";

/** A one-pane layout with one plain terminal tab (and any extra tabs after it). */
export async function seedLayout(
  node: Pick<TopologyNode, "invoke" | "environment">,
  extraTabs: Array<Record<string, unknown>> = [],
  activeTabId = SHELL_TAB,
): Promise<void> {
  const current = await node.invoke<{ revision?: number } | null>("get_pane_layout", {
    environmentId: node.environment.id,
  });
  await node.invoke("save_pane_layout", {
    environmentId: node.environment.id,
    expectedRevision: current?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane-main",
      root: {
        kind: "leaf",
        id: "pane-main",
        activeTabId,
        tabs: [{ id: SHELL_TAB, type: "plain" }, ...extraTabs],
      },
    },
  });
}

async function setDisplayName(gatewayOrInvoke: Pick<Gateway, "invoke">, name: string) {
  const profile = await gatewayOrInvoke.invoke<{ revision: number; displayName?: string }>(
    "get_backend_profile",
  );
  if (profile.displayName === name) return;
  await gatewayOrInvoke.invoke("update_backend_profile", {
    expectedRevision: profile.revision,
    displayName: name,
    colorToken: "blue",
  });
}

/**
 * Attaches the leaf profile and `extraLeafCount` standalone leaves to the
 * command profile, gives every node one started local environment with a
 * terminal tab, and returns them. `stop` deletes the environments made on the
 * profiles and stops the standalone leaves (their data directories go with
 * the temporary root).
 */
export async function startTopology(label: string): Promise<Topology> {
  const commandGateway = gateway(commandProfile);
  const leafGateway = gateway(leafProfile);
  await setDisplayName(commandGateway, "Cmd4006");
  await setDisplayName(leafGateway, "Leaf4006");
  // Attached afresh: the leaf learns the command node's current origins only
  // on attach (`update_node` keeps the old ones), and a stale list refuses the
  // browser's direct requests, which then fall back to the relay unseen.
  const { nodeId: existingLeafId } = await leafGateway.invoke<{ nodeId: string }>(
    "get_node_status",
  );
  await commandGateway.invoke("forget_node", { nodeId: existingLeafId }).catch(() => undefined);
  const { nodeId: leafNodeId } = await attachLeaf(commandGateway, leafGateway);
  const { nodeId: commandNodeId } = await commandGateway.invoke<{ nodeId: string }>(
    "get_node_status",
  );
  const stamp = Date.now().toString(36);
  const commandEnvironment = await createLeafEnvironment(commandGateway, `cmd-${label}-${stamp}`);
  const leafEnvironment = await createLeafEnvironment(leafGateway, `leaf1-${label}-${stamp}`);
  const command = {
    name: "Cmd4006",
    nodeId: commandNodeId,
    origin: commandGateway.origin,
    environment: { id: commandEnvironment.id, name: `cmd-${label}-${stamp}` },
    invoke: commandGateway.invoke,
    gateway: commandGateway,
  };
  const leaves: TopologyNode[] = [
    {
      name: "Leaf4006",
      nodeId: leafNodeId,
      origin: leafGateway.origin,
      environment: { id: leafEnvironment.id, name: `leaf1-${label}-${stamp}` },
      invoke: leafGateway.invoke,
    },
  ];
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "uf-4006-leaves-"));
  const children: ChildProcess[] = [];
  const stop = async () => {
    await commandGateway
      .invoke("delete_environment", { environmentId: command.environment.id })
      .catch(() => undefined);
    await leafGateway
      .invoke("delete_environment", { environmentId: leaves[0]!.environment.id })
      .catch(() => undefined);
    for (const node of leaves.slice(1)) {
      await commandGateway.invoke("forget_node", { nodeId: node.nodeId }).catch(() => undefined);
    }
    for (const child of children) {
      if (child.exitCode !== null) continue;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  };
  try {
    for (let index = 0; index < extraLeafCount; index += 1) {
      const name = `Leaf4006x${index + 2}`;
      const environmentName = `leaf${index + 2}-${label}-${stamp}`;
      const leaf = await startLeaf(temporaryRoot, { name, environmentName });
      children.push(leaf.child);
      await leaf.invoke("start_environment", { environmentId: leaf.environment.id });
      await commandGateway.invoke("add_node", {
        routes: [{ id: "loopback", kind: "https", enabled: true, origin: leaf.origin }],
        token: leaf.token,
      });
      leaves.push({
        name,
        nodeId: leaf.nodeId,
        origin: leaf.origin,
        environment: { id: leaf.environment.id, name: environmentName },
        invoke: leaf.invoke,
      });
    }
    // Every extra leaf's environment has a worktree and every node is listed.
    const deadline = Date.now() + 120_000;
    for (const node of leaves.slice(1)) {
      for (;;) {
        const environment = await node.invoke<{ status?: string; worktreePath?: string | null }>(
          "get_environment",
          { environmentId: node.environment.id },
        );
        if (environment.worktreePath && environment.status === "running") break;
        if (Date.now() > deadline) throw new Error(`${node.name}'s environment never started.`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    for (;;) {
      const summaries = await commandGateway.invoke<{
        nodes: Array<{ nodeId: string; environments?: unknown[] }>;
      }>("get_node_summaries");
      const listed = leaves.every((leaf) =>
        summaries.nodes.some((node) => node.nodeId === leaf.nodeId),
      );
      if (listed) break;
      if (Date.now() > deadline) throw new Error("The command node never listed every leaf.");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (const node of [command, ...leaves]) await seedLayout(node);
    return { command, leaves, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Writes one evidence file (ids, timings, counts; never a credential or terminal content). */
export function writeEvidence(name: string, value: unknown): string {
  mkdirSync(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
  return file;
}

/** Startup dialogs the credential-free fixture opens, closed for this run only. */
export async function dismissDialogs(page: Page): Promise<void> {
  for (const text of [
    "Continue Without Claude",
    "Continue Without GitHub CLI",
    "Continue Without Docker",
    "Continue anyway",
    "Dismiss",
  ]) {
    await page
      .locator(`button:has-text("${text}")`)
      .first()
      .click({ timeout: 500 })
      .catch(() => undefined);
  }
}

/** The sidebar button that opens `environment` on its node. */
export function environmentButton(page: Page, node: TopologyNode): Locator {
  const escaped = node.environment.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("button", { name: new RegExp(`^${escaped}, on `) }).first();
}

/** The window's region for an in-tree node. */
export function inTreeRegion(page: Page, nodeId: string): Locator {
  return page.locator(`[data-testid="in-tree-workspace"][data-node="${nodeId}"]`);
}

/** What the runtime shim guard saw (plan item 4004), or null when its probe is absent. */
export async function shimGuard(
  page: Page,
): Promise<{ mode: string; uses: unknown[]; mountedLeaves: string[] } | null> {
  return page.evaluate(() => {
    const probe = (
      window as unknown as {
        orkestratorShimGuard?: {
          mode: string;
          uses(): unknown[];
          mountedLeaves(): string[];
        };
      }
    ).orkestratorShimGuard;
    return probe
      ? { mode: probe.mode, uses: probe.uses(), mountedLeaves: probe.mountedLeaves() }
      : null;
  });
}

/**
 * The terminal tab's rendered text for `environmentId` on `nodeId`, read from
 * the renderer's own terminal (the Vite dev module the app runs).
 */
export async function renderedTerminal(
  target: Page,
  nodeId: string | null,
  environmentId: string,
): Promise<string> {
  return target.evaluate(
    async ({ nodeId, environmentId, tabId }) => {
      const modulePath = "/src/stores/terminalPortalStore.ts";
      const { useTerminalPortalStore, commandTerminalPortalNodeId } = await import(
        /* @vite-ignore */ modulePath
      );
      const buffer = useTerminalPortalStore
        .getState()
        .getTerminal(nodeId ?? commandTerminalPortalNodeId(), environmentId, tabId)?.terminal
        .buffer.active;
      if (!buffer) return "";
      const lines: string[] = [];
      for (let index = 0; index < buffer.length; index += 1) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
      }
      return lines.join("\n");
    },
    { nodeId, environmentId, tabId: SHELL_TAB },
  );
}

/** The window lifecycle's view of every managed node (plan item 4002). */
export interface LifecycleView {
  tiers: Record<string, string>;
  shownNodeId: string | null;
  size: number;
  estimateBytes: number;
  reading: { bytes: number; source: string; budgetBytes: number } | null;
  config: { memoryBudgetBytes: number; memorySource: string; scopeEstimateBytes: number };
  heapUsedBytes: number | null;
}

export async function lifecycleView(page: Page): Promise<LifecycleView> {
  return page.evaluate(async () => {
    const modulePath = "/src/lib/node-scope/app-window-scope.ts";
    const { getWindowScope } = await import(/* @vite-ignore */ modulePath);
    const lifecycle = getWindowScope().lifecycle;
    const reading = await lifecycle.readMemory().catch(() => null);
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      tiers: Object.fromEntries(lifecycle.tiers.get()) as Record<string, string>,
      shownNodeId: lifecycle.shownNodeId,
      size: lifecycle.size,
      estimateBytes: lifecycle.estimateBytes(),
      reading: reading && {
        bytes: reading.bytes,
        source: reading.source,
        budgetBytes: reading.budgetBytes,
      },
      config: {
        memoryBudgetBytes: lifecycle.config.memoryBudgetBytes,
        memorySource: lifecycle.config.memorySource,
        scopeEstimateBytes: lifecycle.config.scopeEstimateBytes,
      },
      heapUsedBytes: memory?.usedJSHeapSize ?? null,
    };
  });
}

/**
 * The page's JS heap after a full collection (CDP `HeapProfiler.collectGarbage`
 * then `Runtime.getHeapUsage`), in bytes, or null when CDP is unavailable.
 */
export async function collectedHeapBytes(page: Page): Promise<number | null> {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("HeapProfiler.collectGarbage");
      const usage = (await session.send("Runtime.getHeapUsage")) as { usedSize: number };
      return usage.usedSize;
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch {
    return null;
  }
}

/** Changes the window lifecycle's settings at runtime (`ScopeLifecycle.configure`). */
export async function configureLifecycle(
  page: Page,
  settings: Record<string, number | string | null>,
): Promise<void> {
  await page.evaluate(async (settings) => {
    const modulePath = "/src/lib/node-scope/app-window-scope.ts";
    const { getWindowScope } = await import(/* @vite-ignore */ modulePath);
    getWindowScope().lifecycle.configure(settings);
  }, settings);
}

/** Counts sounds and notifications the window raises (installed before the app loads). */
export function installCueCounters(): void {
  const top = window as unknown as {
    __mnSounds?: number[];
    __mnNotifications?: number[];
  };
  top.__mnSounds = [];
  top.__mnNotifications = [];
  const AudioContextClass = (window as unknown as { AudioContext?: typeof AudioContext })
    .AudioContext;
  if (AudioContextClass) {
    const original = AudioContextClass.prototype.createOscillator;
    AudioContextClass.prototype.createOscillator = function (this: AudioContext) {
      top.__mnSounds!.push(Date.now());
      return original.apply(this);
    };
  }
  const Stub = function (this: unknown) {
    top.__mnNotifications!.push(Date.now());
  } as unknown as { permission: string; requestPermission(): Promise<string> };
  Stub.permission = "granted";
  Stub.requestPermission = async () => "granted";
  (Stub as unknown as { prototype: object }).prototype = {
    addEventListener() {},
    removeEventListener() {},
    close() {},
  };
  (window as unknown as { Notification: unknown }).Notification = Stub;
}

/** Cues heard so far: sounds grouped 400 ms apart (one cue plays several oscillators), notifications. */
export async function cues(page: Page): Promise<{ sounds: number; notifications: number }> {
  return page.evaluate(() => {
    const top = window as unknown as { __mnSounds?: number[]; __mnNotifications?: number[] };
    let sounds = 0;
    let last = Number.NEGATIVE_INFINITY;
    for (const at of top.__mnSounds ?? []) {
      if (at - last > 400) sounds += 1;
      last = at;
    }
    return { sounds, notifications: (top.__mnNotifications ?? []).length };
  });
}

/**
 * Raises one `environment-attention` (`terminal_finished`) on a node's
 * environment with no provider turn: clears its unread mark, then runs one
 * command in an activity-tracked terminal (plan items 0002 and 5001).
 */
export async function raiseTerminalAttention(
  node: TopologyNode,
  key: string,
): Promise<{
  unreadBefore: boolean;
  unreadAfter: boolean;
  reason: string | null;
}> {
  const environmentId = node.environment.id;
  type Environment = {
    hasUnreadWork?: boolean;
    lastActivityAt?: string | null;
    unreadReason?: string;
  };
  const before = await node.invoke<Environment>("get_environment", { environmentId });
  if (before.hasUnreadWork) {
    await node.invoke("set_environment_unread", {
      environmentId,
      unread: false,
      expectedLastActivityAt: before.lastActivityAt ?? null,
    });
  }
  const cleared = await node.invoke<Environment>("get_environment", { environmentId });
  const session = await node.invoke<{ sessionId: string }>("create_local_terminal_session", {
    environmentId,
    terminalKey: `uf-4006-attention-${key}`,
    cols: 80,
    rows: 24,
    trackEnvironmentActivity: true,
  });
  await node.invoke("start_local_terminal_session", { sessionId: session.sessionId });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await node.invoke("local_terminal_write", { sessionId: session.sessionId, data: "true\n" });
  let after = cleared;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    after = await node.invoke<Environment>("get_environment", { environmentId });
    if (after.hasUnreadWork) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await node
    .invoke("close_local_terminal_session", { sessionId: session.sessionId })
    .catch(() => undefined);
  return {
    unreadBefore: cleared.hasUnreadWork === true,
    unreadAfter: after.hasUnreadWork === true,
    reason: after.unreadReason ?? null,
  };
}
