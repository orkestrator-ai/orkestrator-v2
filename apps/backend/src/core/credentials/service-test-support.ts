import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import { tmpdir } from "node:os";
import path from "node:path";
import { CREDENTIAL_ANY_TAB } from "@orkestrator/protocol/agent-credentials";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { StorageService } from "../storage.js";
import type { CredentialCaller } from "./access.js";
import type { CredentialHost, CredentialRuntimeInfo, CredentialSessionInfo } from "./context.js";
import type { CredentialServiceOptions } from "./context.js";
import type { CredentialLaunch } from "./runner.js";
import { CredentialService } from "./service.js";
import { MemoryCredentialVault } from "./vault.js";

/**
 * A credential service over a real temporary database, with a host whose
 * session, runtime and launch answers a test sets directly, a fake clock and
 * a memory vault. Commands run in a temporary worktree with `/bin/sh`.
 */
export interface CredentialHarness {
  service: CredentialService;
  storage: StorageService;
  vault: MemoryCredentialVault;
  dataDir: string;
  worktree: string;
  caller: CredentialCaller;
  host: CredentialHost;
  sessions: Map<string, CredentialSessionInfo | null>;
  runtimes: Map<string, CredentialRuntimeInfo | null>;
  clock: { now: number; monotonic: number };
  advance(ms: number): void;
  /** Builds another service over the same records (a restarted backend). */
  restart(overrides?: Partial<CredentialServiceOptions>): CredentialService;
  /** Where commands run; defaults to a worktree run with `/bin/sh`. */
  setLaunch(launch: CredentialLaunch): void;
  close(): Promise<void>;
}

export const TEST_SECRET = "orkcanary-credential-value-7f3a91";

export function interactivePolicy(
  overrides: Partial<NativeAgentExecutionPolicy> = {},
): NativeAgentExecutionPolicy {
  return {
    id: "interactive-host",
    sandbox: "none",
    approvals: "auto-approve",
    projectResources: false,
    networkAccess: "full",
    ...overrides,
  };
}

export async function createCredentialHarness(
  options: Partial<CredentialServiceOptions> = {},
): Promise<CredentialHarness> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-credentials-"));
  const worktree = path.join(dataDir, "worktree");
  await fs.mkdir(worktree);
  const storage = new StorageService(dataDir);
  await storage.init();
  const caller: CredentialCaller = {
    environmentId: "env-1",
    projectId: "project-1",
    tabId: "tab-1",
  };
  const sessions = new Map<string, CredentialSessionInfo | null>();
  const runtimes = new Map<string, CredentialRuntimeInfo | null>();
  const sessionKey = (environmentId: string, tabId: string) => `${environmentId}\0${tabId}`;
  sessions.set(sessionKey("env-1", "tab-1"), {
    agent: "claude",
    logicalSessionKey: "env-env-1:tab-1",
    providerSessionId: "provider-session-1",
    policy: interactivePolicy(),
  });
  sessions.set(sessionKey("env-1", "tab-2"), {
    agent: "claude",
    logicalSessionKey: "env-env-1:tab-2",
    providerSessionId: "provider-session-2",
    policy: interactivePolicy(),
  });
  runtimes.set("env-1", {
    runtime: { kind: "worktree", isolation: "trusted-local" },
    identity: `worktree:${worktree}`,
  });
  const clock = { now: 1_800_000_000_000, monotonic: 1_000 };
  let launch: CredentialLaunch = {
    target: "worktree",
    cwd: worktree,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    shell: "/bin/sh",
  };
  const host: CredentialHost = {
    async hasApprovalTab(environmentId, tabId) {
      return environmentId === "env-1" && [CREDENTIAL_ANY_TAB, "tab-1", "tab-2"].includes(tabId);
    },
    async session(environmentId, tabId) {
      return sessions.get(sessionKey(environmentId, tabId)) ?? null;
    },
    async runtime(environmentId) {
      return runtimes.get(environmentId) ?? null;
    },
    async launch() {
      return { ...launch, env: { ...launch.env } };
    },
  };
  const vault = new MemoryCredentialVault();
  const build = (overrides: Partial<CredentialServiceOptions> = {}) =>
    new CredentialService({
      records: storage.credentialRecordStore(),
      vault,
      vaultStatus: { durable: "keychain", canSave: true, detail: "test vault" },
      host,
      runRoot: path.join(dataDir, "credentials", "runs"),
      now: () => clock.now,
      monotonic: () => clock.monotonic,
      sweepIntervalMs: 0,
      resolveHttpAddress: async () => [{ address: "1.1.1.1" }],
      ...options,
      ...overrides,
    });
  const services: CredentialService[] = [];
  const service = build();
  services.push(service);
  service.start();
  return {
    service,
    storage,
    vault,
    dataDir,
    worktree,
    caller,
    host,
    sessions,
    runtimes,
    clock,
    advance(ms) {
      clock.now += ms;
      clock.monotonic += ms;
    },
    setLaunch(next) {
      launch = next;
    },
    restart(overrides) {
      const next = build(overrides);
      services.push(next);
      return next;
    },
    async close() {
      for (const each of services) each.stop();
      storage.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** One process the fake spawner was asked to start. */
export interface FakeSpawn {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  input: string;
}

/**
 * A `spawn` stand-in: records what each process would have been started
 * with and answers through `behave`, which writes its output. Processes
 * "exit" on the next tick, so tests need no real shell and no wall clock.
 */
export function fakeSpawner(
  behave: (spawned: FakeSpawn) => { stdout?: string; stderr?: string; code?: number } = () => ({}),
) {
  const spawned: FakeSpawn[] = [];
  let nextPid = fakePid(1);
  const spawnProcess = ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    const record: FakeSpawn = { command, args: [...args], env: { ...options.env }, input: "" };
    spawned.push(record);
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: (signal?: string) => boolean;
    };
    child.pid = nextPid++;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on("data", (chunk: Buffer) => {
      record.input += chunk.toString("utf8");
    });
    child.kill = () => true;
    queueMicrotask(() => {
      child.emit("spawn");
      setImmediate(() => {
        const answer = behave(record);
        if (answer.stdout) child.stdout.write(answer.stdout);
        if (answer.stderr) child.stderr.write(answer.stderr);
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", answer.code ?? 0, null);
        setImmediate(() => child.emit("close", answer.code ?? 0, null));
      });
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawned, spawnProcess };
}
