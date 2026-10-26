/**
 * Isolated fixtures for MCP management tests: a temporary home, worktree and
 * data directory, fake storage and a scriptable runtime probe. Nothing here
 * reads or writes the operator's real configuration.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { McpManagementSnapshot, McpMutation } from "@orkestrator/protocol/mcp-management";

import type { ApplySession, CodexReloadOutcome, ReloadOutcome, RuntimeProbe } from "./apply.js";
import type { RuntimeEvidenceRead } from "./evidence.js";
import type { ContainerNetworkView } from "./network-hints.js";
import { McpManagementService } from "./service.js";
import { contentDigest } from "./source-store.js";

export const SENTINEL = "SENTINEL-SECRET-7f3a";

export interface Fixture {
  root: string;
  home: string;
  worktree: string;
  dataDir: string;
  events: Array<[string, unknown]>;
  sessions: ApplySession[];
  sessionReadControl: { read?: () => ApplySession[] | Promise<ApplySession[]> };
  activity: Map<string, "idle" | "working" | "waiting" | "unknown">;
  reloads: string[];
  reloadFailure: { value: Error | null };
  reloadControl: { wait?: () => Promise<void> };
  /** What the fake Codex bridge answers to a reload that does not fail. */
  reloadOutcome: { value: CodexReloadOutcome };
  /**
   * What the fake OpenCode server answers to an instance reload, and the MCP
   * servers the rebuilt instance lists. Defaults to `unsupported` (restart).
   */
  openCodeReload: { value: { outcome: ReloadOutcome; names?: string[] } | Error };
  /** Every OpenCode reload, in order, by environment id. */
  openCodeReloads: string[];
  /**
   * What each session's bridge reports about its MCP configuration, keyed
   * `environmentId:agent:logicalSessionKey`. Absent keys answer `none`; an
   * Error value makes the read reject.
   */
  evidence: Map<string, RuntimeEvidenceRead | Error>;
  /** Every evidence read, in order, as `environmentId:agent:logicalSessionKey`. */
  evidenceReads: string[];
  /** Runs inside each evidence read, before it answers (a runtime replaced mid-read). */
  evidenceHook: { onRead?: (id: string) => void };
  /** Stored rollout settings the service reads (`global.mcpManagement`). */
  rollout: { value: unknown };
  environment: Record<string, unknown>;
  extraEnvironments: Record<string, unknown>[];
  /** Files inside the fake container, by absolute container path. */
  containerFiles: Map<string, string>;
  /** Every accepted container write, in order: path and mode. */
  containerWriteControl: { failNext?: boolean; afterWrite?: () => Promise<void> };
  containerWrites: Array<{ path: string; mode: "private" | "preserve" }>;
  /** Current boot id of the fake container; `null` is an image without boot status. */
  containerBoot: { value: string | null };
  /** Absolute paths that exist in the fake container, and as what. */
  containerPaths: Map<string, "file" | "directory">;
  /** The fake container's network policy. */
  containerNetwork: { value: ContainerNetworkView | null };
  /** Staged inputs a defaults refresh rewrote, by source id. */
  stagedDefaults: Map<string, string>;
  probe: RuntimeProbe;
  service: McpManagementService;
  now: { value: number };
  write(relative: string, content: string): string;
  read(relative: string): string;
  newService(): McpManagementService;
  cleanup(): void;
}

export function createFixture(
  options: { environmentType?: "local" | "containerized"; env?: NodeJS.ProcessEnv } = {},
): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "mcp-mgmt-"));
  const home = path.join(root, "home");
  const worktree = path.join(root, "worktree");
  const dataDir = path.join(root, "data");
  for (const dir of [home, worktree, dataDir]) mkdirSync(dir, { recursive: true });
  const events: Array<[string, unknown]> = [];
  const sessions: ApplySession[] = [];
  const sessionReadControl: Fixture["sessionReadControl"] = {};
  const activity = new Map<string, "idle" | "working" | "waiting" | "unknown">();
  const reloads: string[] = [];
  const reloadFailure = { value: null as Error | null };
  const reloadControl: { wait?: () => Promise<void> } = {};
  const reloadOutcome = { value: "reloaded" as CodexReloadOutcome };
  const openCodeReload: Fixture["openCodeReload"] = { value: { outcome: "unsupported" } };
  const openCodeReloads: string[] = [];
  const rollout = { value: undefined as unknown };
  const evidence = new Map<string, RuntimeEvidenceRead | Error>();
  const evidenceReads: string[] = [];
  const evidenceHook: { onRead?: (id: string) => void } = {};
  const now = { value: Date.parse("2026-09-23T12:00:00Z") };
  const containerFiles = new Map<string, string>();
  const containerWrites: Array<{ path: string; mode: "private" | "preserve" }> = [];
  const containerWriteControl: Fixture["containerWriteControl"] = {};
  const containerBoot = { value: "boot-1" as string | null };
  const containerPaths = new Map<string, "file" | "directory">();
  const containerNetwork = { value: null as ContainerNetworkView | null };
  const stagedDefaults = new Map<string, string>();
  const environment: Record<string, unknown> = {
    id: "env-1",
    name: "env-one",
    projectId: "proj-1",
    createdAt: "2026-09-01T00:00:00Z",
    environmentType: options.environmentType ?? "local",
    worktreePath: worktree,
    status: "running",
    localClaudePort: 1,
    localCodexPort: 2,
    localCursorPort: 3,
    localGrokPort: 4,
    localOpencodePort: 5,
    localPiPort: 6,
  };
  const extraEnvironments: Record<string, unknown>[] = [];
  const probe: RuntimeProbe = {
    environments: async () =>
      [environment, ...extraEnvironments].map((environment) => {
        return {
          id: environment.id as string,
          name: environment.name as string,
          status: environment.status as string,
          environmentType: environment.environmentType as "local" | "containerized",
          providerRunning: (provider: AgentPlatform) =>
            environment.status === "running" && provider !== ("none" as never),
          bridgePid: (provider: AgentPlatform) => {
            const pid = environment[`${provider}BridgePid`];
            return typeof pid === "number" ? pid : undefined;
          },
        };
      }),
    sessions: async () => (sessionReadControl.read ? sessionReadControl.read() : sessions),
    activity: (environmentId, agent, key) =>
      activity.get(`${environmentId}:${agent}:${key}`) ?? "idle",
    reloadCodex: async (environmentId) => {
      await reloadControl.wait?.();
      if (reloadFailure.value) throw reloadFailure.value;
      reloads.push(environmentId);
      return reloadOutcome.value;
    },
    reloadOpenCode: async (environmentId) => {
      openCodeReloads.push(environmentId);
      if (openCodeReload.value instanceof Error) throw openCodeReload.value;
      return openCodeReload.value;
    },
    mcpConfigEvidence: async (environmentId, agent, key) => {
      const id = `${environmentId}:${agent}:${key}`;
      evidenceReads.push(id);
      evidenceHook.onRead?.(id);
      const answer = evidence.get(id);
      if (answer instanceof Error) throw answer;
      return answer ?? { state: "none" };
    },
  };
  const newService = () =>
    new McpManagementService({
      dataDir,
      home,
      env: options.env ?? {},
      lockDir: path.join(root, "locks"),
      now: () => now.value,
      tickMs: 1_000_000,
      storage: {
        getEnvironment: async (id) =>
          ([environment, ...extraEnvironments].find((candidate) => candidate.id === id) ??
            null) as never,
        getProject: async () => ({ id: "proj-1", name: "project-one" }) as never,
        previewServices: {
          getPreviewBackendIdentity: async () => ({ instanceId: "backend-1", created: false }),
        },
      },
      emit: (event, payload) => events.push([event, payload]),
      probe,
      loadRollout: async () => rollout.value,
      readContainerFile: async (_containerId, filePath) => {
        if (environment.status !== "running") return { state: "offline" };
        const text = containerFiles.get(filePath);
        return text === undefined
          ? { state: "absent" }
          : { state: "ok", bytes: new TextEncoder().encode(text) };
      },
      // Compare-and-swap on the exact bytes, like the real writer.
      writeContainerFile: async (_containerId, filePath, write) => {
        if (environment.status !== "running") return { state: "offline" };
        if (containerWriteControl.failNext) {
          containerWriteControl.failNext = false;
          return { state: "failed" };
        }
        const current = containerFiles.get(filePath);
        const digest =
          current === undefined ? "absent" : contentDigest(new TextEncoder().encode(current));
        if (digest !== write.expectedDigest) return { state: "conflict" };
        containerFiles.set(filePath, new TextDecoder().decode(write.bytes));
        containerWrites.push({ path: filePath, mode: write.mode });
        await containerWriteControl.afterWrite?.();
        return { state: "ok" };
      },
      readContainerBootId: async () => containerBoot.value,
      probeContainerPaths: async (_containerId, paths) =>
        new Map(paths.map((candidate) => [candidate, containerPaths.get(candidate) ?? "absent"])),
      containerNetwork: async () => containerNetwork.value,
      stagedDefaults: {
        update: async (_environmentId, _containerId, sourceId, rewrite) => {
          if (sourceId === "claude:user") return "not-needed";
          stagedDefaults.set(sourceId, rewrite(stagedDefaults.get(sourceId) ?? ""));
          return "updated";
        },
      },
    });
  const fixture: Fixture = {
    root,
    home,
    worktree,
    dataDir,
    events,
    sessions,
    sessionReadControl,
    activity,
    reloads,
    reloadFailure,
    reloadControl,
    reloadOutcome,
    openCodeReload,
    openCodeReloads,
    evidence,
    evidenceReads,
    evidenceHook,
    rollout,
    environment,
    extraEnvironments,
    containerFiles,
    containerWrites,
    containerWriteControl,
    containerBoot,
    containerPaths,
    containerNetwork,
    stagedDefaults,
    now,
    probe,
    service: newService(),
    newService,
    write(relative, content) {
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      return file;
    },
    read(relative) {
      return readFileSync(path.join(root, relative), "utf8");
    },
    cleanup() {
      fixture.service.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return fixture;
}

export async function targetIdFor(
  fixture: Fixture,
  provider: AgentPlatform,
  kind: "backend" | "environment",
): Promise<string> {
  const list = await fixture.service.listTargets({
    environmentId: kind === "environment" ? "env-1" : undefined,
  });
  const target = list.targets.find(
    (candidate) => candidate.provider === provider && candidate.context.kind === kind,
  );
  if (!target) throw new Error(`no ${provider} ${kind} target`);
  return target.targetId;
}

let requestCounter = 0;

export function mutation(
  targetId: string,
  operation: McpMutation["operation"],
  applyIntent: McpMutation["applyIntent"] = "save",
): { mutation: McpMutation } {
  requestCounter += 1;
  return { mutation: { requestId: `req-${requestCounter}`, targetId, applyIntent, operation } };
}

export function revision(snapshot: McpManagementSnapshot, sourceId: string): string | null {
  const source = snapshot.sources.find((candidate) => candidate.sourceId === sourceId);
  if (!source) throw new Error(`no source ${sourceId}`);
  return source.revision;
}

export function entry(snapshot: McpManagementSnapshot, sourceId: string, name: string) {
  const found = snapshot.definitions.find(
    (candidate) => candidate.sourceId === sourceId && candidate.name === name,
  );
  if (!found) throw new Error(`no ${name} in ${sourceId}`);
  return found;
}

/**
 * Stop the service's own timer, so only the test's explicit `tick()` calls
 * run passes. Apply arms an immediate background pass, which could otherwise
 * start inside one explicit tick and finish inside the next.
 */
export function pauseScheduler(fixture: Fixture): void {
  const service = fixture.service as unknown as { timer: ReturnType<typeof setTimeout> | null };
  if (service.timer) clearTimeout(service.timer);
  service.timer = null;
}
