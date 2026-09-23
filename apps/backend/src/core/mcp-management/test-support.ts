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

import type { ApplySession, RuntimeProbe } from "./apply.js";
import { McpManagementService } from "./service.js";

export const SENTINEL = "SENTINEL-SECRET-7f3a";

export interface Fixture {
  root: string;
  home: string;
  worktree: string;
  dataDir: string;
  events: Array<[string, unknown]>;
  sessions: ApplySession[];
  activity: Map<string, "idle" | "working" | "waiting" | "unknown">;
  reloads: string[];
  reloadFailure: { value: Error | null };
  reloadControl: { wait?: () => Promise<void> };
  environment: Record<string, unknown>;
  extraEnvironments: Record<string, unknown>[];
  /** Files inside the fake container, by absolute container path. */
  containerFiles: Map<string, string>;
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
  const activity = new Map<string, "idle" | "working" | "waiting" | "unknown">();
  const reloads: string[] = [];
  const reloadFailure = { value: null as Error | null };
  const reloadControl: { wait?: () => Promise<void> } = {};
  const now = { value: Date.parse("2026-09-23T12:00:00Z") };
  const containerFiles = new Map<string, string>();
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
        };
      }),
    sessions: async () => sessions,
    activity: (environmentId, agent, key) =>
      activity.get(`${environmentId}:${agent}:${key}`) ?? "idle",
    reloadCodex: async (environmentId, key) => {
      await reloadControl.wait?.();
      if (reloadFailure.value) throw reloadFailure.value;
      reloads.push(`${environmentId}:${key}`);
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
        getPreviewBackendIdentity: async () => ({ instanceId: "backend-1" }),
      },
      emit: (event, payload) => events.push([event, payload]),
      probe,
      readContainerFile: async (_containerId, filePath) => {
        if (environment.status !== "running") return { state: "offline" };
        const text = containerFiles.get(filePath);
        return text === undefined
          ? { state: "absent" }
          : { state: "ok", bytes: new TextEncoder().encode(text) };
      },
    });
  const fixture: Fixture = {
    root,
    home,
    worktree,
    dataDir,
    events,
    sessions,
    activity,
    reloads,
    reloadFailure,
    reloadControl,
    environment,
    extraEnvironments,
    containerFiles,
    now,
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
