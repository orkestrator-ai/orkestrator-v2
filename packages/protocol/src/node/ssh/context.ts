import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import type { Readable } from "node:stream";
import {
  allocateLoopbackPort,
  probeLoopbackForward,
  type ForwardProbeResult,
} from "./port-allocation.js";
import { locateOpenSshBinaries } from "./ssh-binary.js";

/** The subset of a Node `ChildProcess` the SSH adapter relies on. */
export interface SshChildProcess {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export type SshSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SshChildProcess;

/** File operations the adapter performs; injected so tests can observe them. */
export interface SshFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options: { mode: number; flag?: string }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  isExecutable(path: string): Promise<boolean>;
}

export interface SshClock {
  now(): number;
  /** Resolves after `ms`, or early (without rejecting) when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Structured log sink. Fields must never contain secrets, usernames or raw stderr. */
export interface SshLogger {
  info(message: string, fields?: Record<string, string | number | boolean>): void;
  warn(message: string, fields?: Record<string, string | number | boolean>): void;
}

export interface SshBinaries {
  ssh: string;
  sshKeygen: string | null;
}

export type SshBinaryLookup =
  { ok: true; binaries: SshBinaries } | { ok: false; reason: "not-found" | "unsupported-platform" };

/** How the askpass shell script launches the bundled helper. */
export interface AskpassRuntime {
  command: string;
  env: Record<string, string>;
}

/**
 * Everything the SSH adapter touches outside its own memory. Collaborators
 * receive this shared context instead of importing process-wide singletons, so
 * every spawn, file write, clock read and port probe can be faked in tests.
 */
export interface SshAdapterContext {
  spawn: SshSpawn;
  fs: SshFileSystem;
  clock: SshClock;
  logger: SshLogger;
  randomBytes(size: number): Buffer;
  locateBinaries(): Promise<SshBinaryLookup>;
  allocatePort(): Promise<number>;
  probeForward(port: number, signal?: AbortSignal): Promise<ForwardProbeResult>;
  platform: NodeJS.Platform;
  homedir: string;
  env: NodeJS.ProcessEnv;
  /** Parent directory for private per-operation temporary directories. */
  tmpdir: string;
  /** Orkestrator-owned known_hosts file, e.g. `<userData>/ssh/known_hosts`. */
  knownHostsFile: string;
  askpassRuntime: AskpassRuntime;
  /**
   * Test seam only: an explicit `ssh -F` client config so integration tests
   * never read `~/.ssh/config`. Product code leaves it unset.
   */
  configFile?: string;
}

export const nodeSshFileSystem: SshFileSystem = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  mkdir: (path, options) => mkdir(path, options),
  chmod: (path, mode) => chmod(path, mode),
  readFile: (path, encoding) => readFile(path, encoding),
  writeFile: (path, data, options) => writeFile(path, data, options),
  rename: (from, to) => rename(from, to),
  rm: (path, options) => rm(path, options),
  isExecutable: (path) =>
    access(path, fsConstants.X_OK).then(
      () => true,
      () => false,
    ),
};

export const systemSshClock: SshClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

const silentLogger: SshLogger = { info: () => undefined, warn: () => undefined };

export function createSshAdapterContext(options: {
  knownHostsFile: string;
  logger?: SshLogger;
  configFile?: string;
  overrides?: Partial<SshAdapterContext>;
}): SshAdapterContext {
  const base: SshAdapterContext = {
    spawn: (command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions),
    fs: nodeSshFileSystem,
    clock: systemSshClock,
    logger: options.logger ?? silentLogger,
    randomBytes: (size) => nodeRandomBytes(size),
    locateBinaries: () => Promise.resolve({ ok: false, reason: "not-found" }),
    allocatePort: () => allocateLoopbackPort(),
    probeForward: (port, signal) => probeLoopbackForward(port, { signal }),
    platform: process.platform,
    homedir: os.homedir(),
    env: process.env,
    tmpdir: os.tmpdir(),
    knownHostsFile: options.knownHostsFile,
    askpassRuntime: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } },
  };
  if (options.configFile) base.configFile = options.configFile;
  const context = { ...base, ...options.overrides };
  if (!options.overrides?.locateBinaries) {
    context.locateBinaries = () =>
      locateOpenSshBinaries(context.platform, context.env, context.fs.isExecutable);
  }
  return context;
}
