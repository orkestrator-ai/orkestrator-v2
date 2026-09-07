import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 100_000;
const DEFAULT_TERMINAL_OUTPUT_BYTES = 1024 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TERMINALS = 8;
const MAX_TERMINAL_ARGUMENTS = 4_096;
const MAX_TERMINAL_ENVIRONMENT = 512;

interface TerminalRecord {
  sessionId: string;
  child: TerminalProcess;
  output: BoundedTerminalOutput;
  exitStatus?: { exitCode?: number | null; signal?: string | null };
  exited: Promise<{ exitCode?: number | null; signal?: string | null }>;
}

export interface TerminalProcess {
  kill(): void;
  onData(listener: (data: Buffer | string) => void): void;
  onExit(listener: (exitCode: number | null, signal: string | null) => void): void;
}

const terminalDisplay = new Map<string, TerminalRecord>();

/** Output captured when a terminal content block is normalized into the transcript. */
export function terminalDisplayOutput(terminalId: string): string | undefined {
  return terminalDisplay.get(terminalId)?.output.text();
}

/** Chunked tail buffer: appends never copy or decode the retained transcript. */
export class BoundedTerminalOutput {
  readonly #chunks: Buffer[] = [];
  readonly #limit: number;
  #bytes = 0;
  #head = 0;
  #truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(chunk: Buffer | string): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length === 0) return;
    this.#chunks.push(incoming);
    this.#bytes += incoming.length;
    // Retain three guard bytes so materialization can move past a UTF-8
    // continuation sequence without losing an otherwise complete character.
    const retainedLimit = this.#limit + 3;
    if (this.#bytes <= retainedLimit) return;
    this.#truncated = true;
    let remove = this.#bytes - retainedLimit;
    while (remove > 0) {
      const first = this.#chunks[this.#head]!;
      if (remove >= first.length) {
        this.#head += 1;
        this.#bytes -= first.length;
        remove -= first.length;
      } else {
        this.#chunks[this.#head] = first.subarray(remove);
        this.#bytes -= remove;
        remove = 0;
      }
    }
    // Moving the logical head is O(1). Compact only occasionally so a stream
    // of tiny PTY chunks remains amortized linear after reaching the cap.
    if (this.#head >= 1_024 && this.#head * 2 >= this.#chunks.length) {
      this.#chunks.splice(0, this.#head);
      this.#head = 0;
    }
  }

  text(): string {
    return this.buffer().toString("utf8");
  }

  buffer(): Buffer {
    const activeChunks = this.#chunks.length - this.#head;
    const retained =
      activeChunks === 0
        ? Buffer.alloc(0)
        : activeChunks === 1
          ? this.#chunks[this.#head]!
          : Buffer.concat(this.#chunks.slice(this.#head), this.#bytes);
    return retained.length > this.#limit ? utf8Tail(retained, this.#limit) : retained;
  }

  get truncated(): boolean {
    return this.#truncated || this.#bytes > this.#limit;
  }
}

export class AcpClientMethods {
  readonly #terminals = new Map<string, TerminalRecord>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly spawnTerminalImpl = spawnTerminal,
  ) {}

  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "fs/read_text_file":
        return this.readTextFile(assertReadRequest(params));
      case "fs/write_text_file":
        return this.writeTextFile(assertWriteRequest(params));
      case "terminal/create":
        return this.createTerminal(assertCreateTerminalRequest(params));
      case "terminal/output":
        return this.terminalOutput(assertTerminalRequest(params));
      case "terminal/wait_for_exit":
        return this.waitForTerminalExit(assertTerminalRequest(params));
      case "terminal/kill":
        return this.killTerminal(assertTerminalRequest(params));
      case "terminal/release":
        return this.releaseTerminal(assertTerminalRequest(params));
      default:
        throw new UnsupportedClientMethodError(method);
    }
  }

  async readTextFile(request: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const target = await secureExistingFile(request.path, this.workspaceRoot);
    const handle = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      assertSameFile(stats, target.stats);
      if (stats.size > MAX_FILE_BYTES) throw new Error("ACP file read exceeds the 2 MiB limit");
      const content = (await handle.readFile()).toString("utf8");
      const lines = content.split(/(?<=\n)/);
      const start = request.line === undefined || request.line === null ? 0 : request.line - 1;
      const limit =
        request.limit === undefined || request.limit === null ? lines.length : request.limit;
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 0) {
        throw new Error("ACP file line and limit must be non-negative integers");
      }
      return { content: lines.slice(start, start + Math.min(limit, MAX_READ_LINES)).join("") };
    } finally {
      await handle.close();
    }
  }

  async writeTextFile(request: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    if (Buffer.byteLength(request.content) > MAX_FILE_BYTES) {
      throw new Error("ACP file write exceeds the 2 MiB limit");
    }
    const target = await secureWritableFile(request.path, this.workspaceRoot);
    const handle = await open(
      target.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error("ACP file writes require a regular file");
      if (target.stats) assertSameFile(stats, target.stats);
      await handle.writeFile(request.content, "utf8");
    } finally {
      await handle.close();
    }
    return {};
  }

  async createTerminal(request: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    if (this.#terminals.size >= MAX_TERMINALS) throw new Error("ACP terminal limit reached");
    if (!request.command || request.command.includes("\0")) throw new Error("Invalid ACP command");
    if ((request.args?.length ?? 0) > MAX_TERMINAL_ARGUMENTS) {
      throw new Error("ACP terminal argument limit reached");
    }
    if ((request.env?.length ?? 0) > MAX_TERMINAL_ENVIRONMENT) {
      throw new Error("ACP terminal environment limit reached");
    }
    const cwd = await secureTerminalCwd(request.cwd, this.workspaceRoot);
    const outputLimit = Math.min(
      MAX_TERMINAL_OUTPUT_BYTES,
      Number.isSafeInteger(request.outputByteLimit) && (request.outputByteLimit ?? 0) > 0
        ? request.outputByteLimit!
        : DEFAULT_TERMINAL_OUTPUT_BYTES,
    );
    const terminalId = randomBytes(16).toString("hex");
    const child = this.spawnTerminalImpl(request.command, request.args ?? [], {
      cwd,
      env: {
        ...process.env,
        ...Object.fromEntries((request.env ?? []).map((entry) => [entry.name, entry.value])),
      },
    });
    let resolveExit!: (status: { exitCode?: number | null; signal?: string | null }) => void;
    const exited = new Promise<{ exitCode?: number | null; signal?: string | null }>((resolve) => {
      resolveExit = resolve;
    });
    const record: TerminalRecord = {
      sessionId: request.sessionId,
      child,
      output: new BoundedTerminalOutput(outputLimit),
      exited,
    };
    const append = (chunk: Buffer | string) => {
      record.output.append(chunk);
    };
    child.onData(append);
    child.onExit((exitCode, signal) => {
      record.exitStatus = { exitCode, signal };
      resolveExit(record.exitStatus);
    });
    this.#terminals.set(terminalId, record);
    terminalDisplay.set(terminalId, record);
    return { terminalId };
  }

  terminalOutput(request: TerminalOutputRequest): TerminalOutputResponse {
    const terminal = this.#ownedTerminal(request.sessionId, request.terminalId);
    return {
      output: terminal.output.text(),
      truncated: terminal.output.truncated,
      ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
    };
  }

  async waitForTerminalExit(
    request: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.#ownedTerminal(request.sessionId, request.terminalId);
    return terminal.exitStatus ?? (await terminal.exited);
  }

  killTerminal(request: KillTerminalRequest): Record<string, never> {
    const terminal = this.#ownedTerminal(request.sessionId, request.terminalId);
    if (!terminal.exitStatus) terminal.child.kill();
    return {};
  }

  releaseTerminal(request: ReleaseTerminalRequest): Record<string, never> {
    const terminal = this.#ownedTerminal(request.sessionId, request.terminalId);
    if (!terminal.exitStatus) terminal.child.kill();
    this.#terminals.delete(request.terminalId);
    terminalDisplay.delete(request.terminalId);
    return {};
  }

  close(): void {
    for (const [terminalId, terminal] of this.#terminals) {
      if (!terminal.exitStatus) terminal.child.kill();
      terminalDisplay.delete(terminalId);
    }
    this.#terminals.clear();
  }

  #ownedTerminal(sessionId: string, terminalId: string): TerminalRecord {
    const terminal = this.#terminals.get(terminalId);
    if (!terminal || terminal.sessionId !== sessionId) throw new Error("ACP terminal not found");
    return terminal;
  }
}

export class UnsupportedClientMethodError extends Error {}

async function secureExistingFile(
  requestedPath: string,
  workspaceRoot: string,
): Promise<{ path: string; stats: Stats }> {
  const path = await securePath(requestedPath, workspaceRoot, false);
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile())
    throw new Error("ACP file reads require a regular file");
  return { path, stats };
}

async function secureWritableFile(
  requestedPath: string,
  workspaceRoot: string,
): Promise<{ path: string; stats?: Stats }> {
  const path = await securePath(requestedPath, workspaceRoot, true);
  const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stats?.isSymbolicLink() || (stats && !stats.isFile())) {
    throw new Error("ACP file writes require a regular file");
  }
  return { path, stats };
}

async function securePath(
  requestedPath: string,
  workspaceRoot: string,
  allowMissingLeaf: boolean,
): Promise<string> {
  if (!isAbsolute(requestedPath) || requestedPath.includes("\0")) {
    throw new Error("ACP filesystem paths must be absolute workspace paths");
  }
  const canonicalRoot = await realpath(workspaceRoot);
  const target = resolve(requestedPath);
  if (!isWithin(canonicalRoot, target) || target === canonicalRoot) {
    throw new Error("ACP filesystem path is outside the workspace");
  }
  const segments = relative(canonicalRoot, target).split(sep).filter(Boolean);
  let current = canonicalRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    const isLeaf = index === segments.length - 1;
    const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (allowMissingLeaf && isLeaf && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stats) continue;
    if (stats.isSymbolicLink()) throw new Error("ACP filesystem paths may not contain symlinks");
    if (!isLeaf && !stats.isDirectory())
      throw new Error("ACP filesystem parent is not a directory");
  }
  const canonicalParent = await realpath(dirname(target));
  if (!isWithin(canonicalRoot, canonicalParent)) {
    throw new Error("ACP filesystem path is outside the workspace");
  }
  return target;
}

async function secureTerminalCwd(
  requested: string | null | undefined,
  workspaceRoot: string,
): Promise<string> {
  const root = await realpath(workspaceRoot);
  const requestedCwd = resolve(requested || workspaceRoot);
  if (!isAbsolute(requestedCwd) || !isWithin(root, requestedCwd)) {
    throw new Error("ACP terminal cwd is outside the workspace");
  }
  let current = root;
  for (const segment of relative(root, requestedCwd).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) throw new Error("ACP terminal cwd may not contain symlinks");
    if (!stats.isDirectory()) throw new Error("ACP terminal cwd is not a directory");
  }
  const canonical = await realpath(requestedCwd);
  if (!isWithin(root, canonical)) throw new Error("ACP terminal cwd is outside the workspace");
  return canonical;
}

/** Prefer Bun's runtime-owned PTY; keep a pipe fallback for Node-based tests. */
function spawnTerminal(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): TerminalProcess {
  interface BunTerminal {
    closed: boolean;
    close(): void;
  }
  interface BunSubprocess {
    terminal?: BunTerminal;
    exited: Promise<number>;
    kill(): void;
  }
  interface BunRuntime {
    Terminal?: unknown;
    spawn(
      command: string[],
      options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        terminal: {
          name: string;
          cols: number;
          rows: number;
          data(terminal: BunTerminal, bytes: Uint8Array): void;
        };
      },
    ): BunSubprocess;
  }
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  if (bun && typeof bun.Terminal === "function") {
    const dataListeners = new Set<(data: Buffer) => void>();
    const exitListeners = new Set<(exitCode: number | null, signal: string | null) => void>();
    const decoder = new TextDecoder();
    let subprocess: BunSubprocess;
    try {
      subprocess = bun.spawn([command, ...args], {
        ...options,
        terminal: {
          name: "xterm-256color",
          cols: 120,
          rows: 30,
          data(_terminal, bytes) {
            const text = decoder.decode(bytes, { stream: true });
            if (text) for (const listener of dataListeners) listener(Buffer.from(text));
          },
        },
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const detail = `${code ? `${code}: ` : ""}${error instanceof Error ? error.message : String(error)}`;
      return {
        kill: () => undefined,
        onData: (listener) => queueMicrotask(() => listener(`\n${detail}`)),
        onExit: (listener) => queueMicrotask(() => listener(1, null)),
      };
    }
    void subprocess.exited.then(
      (exitCode) => {
        const tail = decoder.decode();
        if (tail) for (const listener of dataListeners) listener(Buffer.from(tail));
        if (subprocess.terminal && !subprocess.terminal.closed) subprocess.terminal.close();
        for (const listener of exitListeners) listener(exitCode, null);
      },
      () => {
        for (const listener of exitListeners) listener(1, null);
      },
    );
    return {
      kill: () => subprocess.kill(),
      onData: (listener) => dataListeners.add((data) => listener(data)),
      onExit: (listener) => exitListeners.add(listener),
    };
  }

  return spawnNodeTerminal(command, args, options);
}

export function spawnNodeTerminal(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): TerminalProcess {
  const child = spawn(command, args, {
    ...options,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    kill: () => child.kill("SIGTERM"),
    onData(listener) {
      child.stdout.on("data", listener);
      child.stderr.on("data", listener);
      child.once("error", (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        listener(`\n${code ? `${code}: ` : ""}${error.message}`);
      });
    },
    onExit(listener) {
      let settled = false;
      const settle = (exitCode: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        listener(exitCode, signal);
      };
      child.once("exit", settle);
      child.once("error", () => settle(1, null));
    },
  };
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function assertSameFile(actual: Stats, expected: Stats): void {
  if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error("ACP filesystem path changed while it was being accessed");
  }
}

function utf8Tail(value: Buffer, maximumBytes: number): Buffer {
  let start = value.length - maximumBytes;
  while (start < value.length && (value[start]! & 0xc0) === 0x80) start += 1;
  return value.subarray(start);
}

function assertReadRequest(value: unknown): ReadTextFileRequest {
  const request = assertRecord(value);
  if (!isString(request.sessionId) || !isString(request.path))
    throw new Error("Invalid ACP file read");
  return request as ReadTextFileRequest;
}

function assertWriteRequest(value: unknown): WriteTextFileRequest {
  const request = assertRecord(value);
  if (
    !isString(request.sessionId) ||
    !isString(request.path) ||
    typeof request.content !== "string"
  ) {
    throw new Error("Invalid ACP file write");
  }
  return request as WriteTextFileRequest;
}

function assertCreateTerminalRequest(value: unknown): CreateTerminalRequest {
  const request = assertRecord(value);
  if (!isString(request.sessionId) || !isString(request.command)) {
    throw new Error("Invalid ACP terminal create request");
  }
  return request as CreateTerminalRequest;
}

function assertTerminalRequest(
  value: unknown,
): TerminalOutputRequest &
  ReleaseTerminalRequest &
  WaitForTerminalExitRequest &
  KillTerminalRequest {
  const request = assertRecord(value);
  if (!isString(request.sessionId) || !isString(request.terminalId)) {
    throw new Error("Invalid ACP terminal request");
  }
  return request as TerminalOutputRequest &
    ReleaseTerminalRequest &
    WaitForTerminalExitRequest &
    KillTerminalRequest;
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid ACP client request");
  }
  return value as Record<string, unknown>;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 16 * 1024;
}
