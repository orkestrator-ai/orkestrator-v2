import { timingSafeEqual } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { ASKPASS_HELPER_SOURCE } from "./askpass-helper-source.js";
import type { SshAdapterContext } from "./context.js";
import { createPrivateTempDir } from "./ssh-env.js";

export type SshAskpassPromptKind = "passphrase" | "password" | "confirm" | "other";

export type SshAskpassPrompt = {
  kind: SshAskpassPromptKind;
  /** OpenSSH's prompt text, control characters removed and bounded. */
  message: string;
  /** Aborted on timeout, cancellation, ssh exit or tunnel shutdown. */
  signal: AbortSignal;
};

/** Return the answer, or `null` to cancel. Answers are never logged or stored. */
export type SshAskpassHandler = (prompt: SshAskpassPrompt) => Promise<string | null>;

export const MAX_ASKPASS_PROMPT_LENGTH = 1024;
export const MAX_ASKPASS_ANSWER_LENGTH = 4096;
export const ASKPASS_PROMPT_TIMEOUT_MS = 120_000;
const MAX_ASKPASS_REQUEST_BYTES = MAX_ASKPASS_PROMPT_LENGTH * 4 + 512;
const MAX_DISPLAY_MESSAGE_LENGTH = 512;
const REQUEST_READ_TIMEOUT_MS = 5_000;
// sockaddr_un.sun_path is 104 bytes on macOS, 108 on Linux.
const MAX_SOCKET_PATH_BYTES = 100;

type AskpassRequest = { nonce: string; prompt: string; promptType: string };

/**
 * Request-scoped askpass broker for one tunnel attempt. It owns a private 0700
 * directory holding the helper script and a Unix socket; only a client that
 * presents this broker's random nonce gets its prompt forwarded. Disposing it
 * aborts outstanding prompts, closes the socket and deletes the directory.
 */
export class AskpassBroker {
  readonly scriptPath: string;
  readonly socketPath: string;
  #context: SshAdapterContext;
  #dir: string;
  #nonce: string;
  #server: net.Server;
  #handler: SshAskpassHandler;
  #promptTimeoutMs: number;
  #lifetime = new AbortController();
  #sockets = new Set<net.Socket>();
  #disposed: Promise<void> | null = null;
  #active = 0;
  #shown = 0;
  #cancelled = 0;
  #rejected = 0;

  private constructor(input: {
    context: SshAdapterContext;
    dir: string;
    nonce: string;
    server: net.Server;
    handler: SshAskpassHandler;
    promptTimeoutMs: number;
  }) {
    this.#context = input.context;
    this.#dir = input.dir;
    this.#nonce = input.nonce;
    this.#server = input.server;
    this.#handler = input.handler;
    this.#promptTimeoutMs = input.promptTimeoutMs;
    this.scriptPath = path.join(input.dir, "askpass.sh");
    this.socketPath = path.join(input.dir, "a.sock");
    input.server.on("connection", (socket) => this.#accept(socket));
  }

  static async open(
    context: SshAdapterContext,
    handler: SshAskpassHandler,
    options: { promptTimeoutMs?: number } = {},
  ): Promise<AskpassBroker> {
    let dir = await createPrivateTempDir(context, "ork-ssh-");
    if (Buffer.byteLength(path.join(dir, "a.sock")) > MAX_SOCKET_PATH_BYTES) {
      await context.fs.rm(dir, { recursive: true, force: true });
      dir = await createPrivateTempDir({ ...context, tmpdir: "/tmp" }, "ork-ssh-");
    }
    const broker = new AskpassBroker({
      context,
      dir,
      nonce: context.randomBytes(32).toString("hex"),
      server: net.createServer(),
      handler,
      promptTimeoutMs: options.promptTimeoutMs ?? ASKPASS_PROMPT_TIMEOUT_MS,
    });
    try {
      const helperPath = path.join(dir, "askpass-helper.cjs");
      await context.fs.writeFile(helperPath, ASKPASS_HELPER_SOURCE, { mode: 0o600, flag: "wx" });
      await context.fs.writeFile(
        broker.scriptPath,
        askpassScript(context.askpassRuntime, helperPath),
        { mode: 0o700, flag: "wx" },
      );
      await new Promise<void>((resolve, reject) => {
        broker.#server.once("error", reject);
        broker.#server.listen(broker.socketPath, () => {
          broker.#server.off("error", reject);
          resolve();
        });
      });
      await context.fs.chmod(broker.socketPath, 0o600);
    } catch (error) {
      await broker.dispose();
      throw error;
    }
    return broker;
  }

  /** Environment for the ssh child this broker serves. */
  env(): Record<string, string> {
    const env: Record<string, string> = {
      SSH_ASKPASS: this.scriptPath,
      SSH_ASKPASS_REQUIRE: "force",
      ORKESTRATOR_ASKPASS_SOCKET: this.socketPath,
      ORKESTRATOR_ASKPASS_NONCE: this.#nonce,
    };
    if (!this.#context.env.DISPLAY) env.DISPLAY = ":0";
    return env;
  }

  get activePrompts(): number {
    return this.#active;
  }
  get promptsShown(): number {
    return this.#shown;
  }
  get promptsCancelled(): number {
    return this.#cancelled;
  }
  get rejectedConnections(): number {
    return this.#rejected;
  }
  get disposed(): boolean {
    return this.#disposed !== null;
  }

  dispose(): Promise<void> {
    this.#disposed ??= (async () => {
      this.#lifetime.abort();
      for (const socket of this.#sockets) socket.destroy();
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
      await this.#context.fs.rm(this.#dir, { recursive: true, force: true }).catch(() => undefined);
    })();
    return this.#disposed;
  }

  #accept(socket: net.Socket): void {
    if (this.#lifetime.signal.aborted) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    socket.setTimeout(REQUEST_READ_TIMEOUT_MS, () => socket.destroy());
    let buffered = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffered += chunk;
      if (Buffer.byteLength(buffered) > MAX_ASKPASS_REQUEST_BYTES) {
        handled = true;
        this.#reject(socket);
        return;
      }
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      handled = true;
      socket.setTimeout(0);
      const request = parseRequest(buffered.slice(0, end));
      if (!request || !this.#nonceMatches(request.nonce)) {
        this.#reject(socket);
        return;
      }
      if (request.prompt.length > MAX_ASKPASS_PROMPT_LENGTH) {
        this.#reply(socket, null);
        return;
      }
      void this.#prompt(socket, request);
    });
    socket.on("error", () => socket.destroy());
  }

  #nonceMatches(candidate: string): boolean {
    const expected = Buffer.from(this.#nonce, "utf8");
    const actual = Buffer.from(candidate, "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  #reject(socket: net.Socket): void {
    this.#rejected += 1;
    this.#reply(socket, null);
  }

  async #prompt(socket: net.Socket, request: AskpassRequest): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, this.#promptTimeoutMs);
    this.#lifetime.signal.addEventListener("abort", abort, { once: true });
    socket.once("close", abort);
    this.#active += 1;
    this.#shown += 1;
    let answer: string | null = null;
    try {
      answer = await this.#handler({
        kind: promptKind(request.prompt, request.promptType),
        message: sanitizePromptMessage(request.prompt),
        signal: controller.signal,
      });
    } catch {
      answer = null;
    } finally {
      this.#active -= 1;
      clearTimeout(timer);
      this.#lifetime.signal.removeEventListener("abort", abort);
      socket.off("close", abort);
    }
    if (controller.signal.aborted || typeof answer !== "string" || !isAcceptableAnswer(answer)) {
      this.#cancelled += 1;
      this.#reply(socket, null);
      return;
    }
    this.#reply(socket, answer);
  }

  #reply(socket: net.Socket, answer: string | null): void {
    if (socket.destroyed) return;
    const payload = answer === null ? { ok: false } : { ok: true, answer };
    socket.end(`${JSON.stringify(payload)}\n`);
  }
}

function parseRequest(text: string): AskpassRequest | null {
  try {
    const value = JSON.parse(text) as Partial<AskpassRequest> | null;
    if (!value || typeof value !== "object") return null;
    if (typeof value.nonce !== "string" || typeof value.prompt !== "string") return null;
    return {
      nonce: value.nonce,
      prompt: value.prompt,
      promptType: typeof value.promptType === "string" ? value.promptType : "",
    };
  } catch {
    return null;
  }
}

function isAcceptableAnswer(answer: string): boolean {
  return answer.length <= MAX_ASKPASS_ANSWER_LENGTH && !/[\r\n\u0000]/.test(answer);
}

export function promptKind(prompt: string, promptType: string): SshAskpassPromptKind {
  if (promptType.toLowerCase() === "confirm") return "confirm";
  if (/passphrase/i.test(prompt)) return "passphrase";
  if (/password/i.test(prompt)) return "password";
  if (/\(yes\/no/i.test(prompt)) return "confirm";
  return "other";
}

export function sanitizePromptMessage(prompt: string): string {
  const text = prompt
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_DISPLAY_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_DISPLAY_MESSAGE_LENGTH - 1)}…`
    : text;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function askpassScript(runtime: SshAdapterContext["askpassRuntime"], helperPath: string) {
  const assignments = Object.entries(runtime.env)
    .filter(([name]) => /^[A-Z_][A-Z0-9_]*$/.test(name))
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  const prefix = assignments ? `${assignments} ` : "";
  return `#!/bin/sh\n${prefix}exec ${shellQuote(runtime.command)} ${shellQuote(helperPath)} "$@"\n`;
}
