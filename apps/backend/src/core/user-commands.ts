import { randomUUID } from "node:crypto";

import { HumanPromptScanner, normalizeTerminalText } from "@orkestrator/protocol/human-prompts";
import {
  renderUserCommandContextBatch,
  USER_COMMAND_MAX_COMMAND_CHARS,
  USER_COMMAND_MAX_INPUT_CHARS,
  USER_COMMAND_MAX_PER_TAB,
  USER_COMMAND_MAX_RUNNING_PER_TAB,
  USER_COMMAND_OUTPUT_TAIL_CHARS,
  type UserCommandRecord,
  type UserCommandTarget,
} from "@orkestrator/protocol/user-commands";

import type { HumanPromptRegistry } from "./human-prompt-registry.js";
import type { PtyProcess } from "./pty.js";

/**
 * User `!` commands: shell commands a person runs from an agent composer.
 *
 * The backend owns each process, so it keeps running (and keeps its output)
 * while the tab is hidden or the window reloads; the renderer only re-reads
 * `list_user_commands` when told the tab's commands changed. Output is kept as
 * a bounded raw tail and normalised on read, so a carriage-return progress
 * bar never splits across chunks. A scanner watches the output for prompts
 * that need the user (a sign-in link, a code, "Press ENTER", a password) and
 * publishes them to the shared registry, cleared when the command exits.
 *
 * The agent hears about each command once, at the start of its next turn
 * (`takeContext` / `markDelivered`). A command still running then is described
 * as running and offered again when it finishes.
 *
 * Commands do not survive a backend restart: their processes end with it.
 * Output never reaches logs or metrics.
 */

/** How the command is started, resolved per environment by the host. */
export interface UserCommandLaunch {
  target: UserCommandTarget;
  containerId?: string;
  cwd: string;
  spawn: (command: string) => PtyProcess;
  /** Release launch admission after spawn or failure. */
  release?: () => void;
}

export interface UserCommandHost {
  /** Where a tab's commands run; throws a user-facing error when they cannot. */
  resolve(environmentId: string, tabId: string): Promise<UserCommandLaunch>;
  /** Publish a content-free hint that a tab's commands changed. */
  announce(environmentId: string, tabId: string): void;
  prompts: HumanPromptRegistry;
  now?: () => number;
  /** Delay before a burst of output is announced (ms). */
  announceDelayMs?: number;
}

type Running = {
  record: UserCommandRecord;
  raw: string;
  rawTruncated: boolean;
  process: PtyProcess | null;
  scanner: HumanPromptScanner;
  cancelled: boolean;
  /** Delivered to the agent while still running: offer the final result again. */
  deliveredWhileRunning: boolean;
};

export class UserCommandError extends Error {
  constructor(
    readonly code: "invalid" | "busy" | "not-found" | "not-running" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "UserCommandError";
  }
}

const tabKey = (environmentId: string, tabId: string) => `${environmentId}\u0000${tabId}`;

export class UserCommandService {
  private readonly tabs = new Map<string, Running[]>();
  private readonly byId = new Map<string, Running>();
  private readonly pendingAnnounce = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly admissions = new Map<string, number>();
  private readonly blockedEnvironments = new Set<string>();
  private readonly blockedTabs = new Set<string>();
  private readonly closingOwners = new Map<string, number>();
  private stopping = false;
  private readonly generations = new Map<string, number>();

  constructor(private readonly host: UserCommandHost) {
    this.now = host.now ?? Date.now;
  }

  async run(input: {
    environmentId: string;
    tabId: string;
    command: string;
  }): Promise<UserCommandRecord> {
    const command = input.command.trim();
    if (!command) throw new UserCommandError("invalid", "Type a command after the !.");
    if (command.length > USER_COMMAND_MAX_COMMAND_CHARS) {
      throw new UserCommandError("invalid", "That command is too long.");
    }
    const key = tabKey(input.environmentId, input.tabId);
    this.assertAdmission(input.environmentId, key);
    const generation = this.generations.get(key) ?? 0;
    const environmentGeneration = this.generations.get(input.environmentId) ?? 0;
    const list = this.tabs.get(key) ?? [];
    const admitted = this.admissions.get(key) ?? 0;
    const running = list.filter((entry) => entry.record.status === "running").length + admitted;
    if (running >= USER_COMMAND_MAX_RUNNING_PER_TAB) {
      throw new UserCommandError(
        "busy",
        "Four commands are already starting or running in this tab. Cancel one first.",
      );
    }
    if (
      list.filter(
        (entry) => entry.record.status === "running" || entry.record.context.state === "pending",
      ).length +
        admitted >=
      USER_COMMAND_MAX_PER_TAB
    ) {
      throw new UserCommandError(
        "busy",
        "This tab has twenty unread commands. Send an agent message before running another.",
      );
    }
    this.admissions.set(key, admitted + 1);
    let launch: UserCommandLaunch | undefined;
    try {
      launch = await this.host.resolve(input.environmentId, input.tabId);
      this.assertAdmission(input.environmentId, key);
      if (
        generation !== (this.generations.get(key) ?? 0) ||
        environmentGeneration !== (this.generations.get(input.environmentId) ?? 0)
      ) {
        throw new UserCommandError("unavailable", "This command owner is closing or unavailable.");
      }
    } catch (error) {
      launch?.release?.();
      throw error;
    } finally {
      const count = (this.admissions.get(key) ?? 1) - 1;
      if (count) this.admissions.set(key, count);
      else {
        this.admissions.delete(key);
        this.generations.delete(key);
        if (
          !Array.from(this.admissions.keys()).some((pending) =>
            pending.startsWith(`${input.environmentId}\u0000`),
          )
        )
          this.generations.delete(input.environmentId);
      }
    }
    const entry: Running = {
      record: {
        id: randomUUID(),
        environmentId: input.environmentId,
        tabId: input.tabId,
        command,
        target: launch.target,
        cwd: launch.cwd,
        status: "running",
        startedAt: new Date(this.now()).toISOString(),
        output: "",
        outputTruncated: false,
        context: { state: "pending" },
        revision: 1,
      },
      raw: "",
      rawTruncated: false,
      process: null,
      scanner: new HumanPromptScanner(),
      cancelled: false,
      deliveredWhileRunning: false,
    };
    this.add(key, entry);
    try {
      entry.process = launch.spawn(command);
    } catch (error) {
      this.finish(entry, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return this.snapshot(entry);
    } finally {
      launch.release?.();
    }
    entry.process.onData((data) => this.output(entry, data));
    entry.process.onExit(({ exitCode }) => {
      // A host child exit alone does not confirm descendant termination.
      if (entry.cancelled) return;
      this.finish(entry, { status: "exited", exitCode });
    });
    this.announce(entry, true);
    return this.snapshot(entry);
  }

  /** Send text to a running command; `enter` appends a carriage return. */
  write(id: string, text: string, options: { enter?: boolean } = {}): UserCommandRecord {
    const entry = this.require(id);
    if (entry.record.status !== "running" || !entry.process) {
      throw new UserCommandError("not-running", "That command is no longer running.");
    }
    if (text.length > USER_COMMAND_MAX_INPUT_CHARS) {
      throw new UserCommandError("invalid", "That input is too long.");
    }
    // Typed input is never stored: it may be a password.
    entry.process.write(`${text}${options.enter === false ? "" : "\r"}`);
    return this.snapshot(entry);
  }

  async cancel(id: string): Promise<UserCommandRecord> {
    const entry = this.require(id);
    if (entry.record.status !== "running") return this.snapshot(entry);
    entry.cancelled = true;
    if (!entry.process) {
      this.finish(entry, { status: "cancelled" });
      return this.snapshot(entry);
    }
    // Ctrl-C first, as a terminal would; then the whole process tree.
    try {
      entry.process.write("\u0003");
    } catch {
      // The process may already be gone.
    }
    const exited = await entry.process.terminate({ graceMs: 1_000 }).catch(() => false);
    if (!exited) {
      throw new UserCommandError(
        "unavailable",
        "Command termination could not be confirmed. It remains tracked; retry cancellation.",
      );
    }
    if (entry.record.status === "running") this.finish(entry, { status: "cancelled" });
    return this.snapshot(entry);
  }

  list(environmentId: string, tabId: string): UserCommandRecord[] {
    return (this.tabs.get(tabKey(environmentId, tabId)) ?? []).map((entry) => this.snapshot(entry));
  }

  get(id: string): UserCommandRecord {
    return this.snapshot(this.require(id));
  }

  /** Whether a command in this environment is still running. */
  hasRunning(environmentId: string): boolean {
    for (const [key, count] of this.admissions) {
      if (count && key.startsWith(`${environmentId}\u0000`)) return true;
    }
    for (const entry of this.byId.values()) {
      if (entry.record.environmentId === environmentId && entry.record.status === "running") {
        return true;
      }
    }
    return false;
  }

  /**
   * The block the agent's next prompt starts with, and the commands it
   * covers. Nothing is marked delivered until `markDelivered`, so a prompt
   * that fails to dispatch offers the same commands again.
   */
  takeContext(environmentId: string, tabId: string): { block: string; ids: string[] } {
    const pending = (this.tabs.get(tabKey(environmentId, tabId)) ?? []).filter(
      (entry) => entry.record.context.state === "pending",
    );
    if (pending.length === 0) return { block: "", ids: [] };
    const rendered = renderUserCommandContextBatch(pending.map((entry) => this.snapshot(entry)));
    const included = new Set(rendered.includedIds);
    return {
      block: rendered.block,
      // The revision belongs to the snapshot the provider will actually receive.
      ids: pending
        .filter((entry) => included.has(entry.record.id))
        .map((entry) => `${entry.record.id}:${entry.record.revision}`),
    };
  }

  markDelivered(ids: readonly string[], requestId: string): void {
    const at = new Date(this.now()).toISOString();
    for (const token of ids) {
      const separator = token.lastIndexOf(":");
      const entry = this.byId.get(token.slice(0, separator));
      const revision = Number(token.slice(separator + 1));
      if (!entry || entry.record.revision !== revision || entry.record.context.state !== "pending")
        continue;
      entry.record.context = { state: "delivered", requestId, at };
      if (entry.record.status === "running") entry.deliveredWhileRunning = true;
      this.bump(entry);
      this.announce(entry, true);
    }
  }

  private assertAdmission(environmentId: string, key: string): void {
    if (
      this.stopping ||
      this.blockedEnvironments.has(environmentId) ||
      this.blockedTabs.has(key) ||
      this.closingOwners.has(environmentId) ||
      this.closingOwners.has(key)
    ) {
      throw new UserCommandError("unavailable", "This command owner is closing or unavailable.");
    }
  }

  /** Keep admission closed until the owning UI record has finished closing. */
  beginOwnerClose(environmentId: string, tabId?: string): () => void {
    const key = tabId ? tabKey(environmentId, tabId) : environmentId;
    this.closingOwners.set(key, (this.closingOwners.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.closingOwners.get(key) ?? 1) - 1;
      if (remaining) this.closingOwners.set(key, remaining);
      else this.closingOwners.delete(key);
    };
  }

  async terminateForTab(environmentId: string, tabId: string): Promise<void> {
    const key = tabKey(environmentId, tabId);
    if (this.admissions.has(key)) this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.blockedTabs.add(key);
    const entries = this.tabs.get(tabKey(environmentId, tabId)) ?? [];
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.record.status === "running") await this.cancel(entry.record.id);
      }),
    );
    for (const entry of Array.from(entries)) this.remove(entry);
    this.host.prompts.clearTab(environmentId, tabId);
    this.blockedTabs.delete(key);
  }

  /** Stop every command of an environment, waiting for each process tree. */
  async terminateForEnvironment(environmentId: string): Promise<void> {
    if (Array.from(this.admissions.keys()).some((key) => key.startsWith(`${environmentId}\u0000`)))
      this.generations.set(environmentId, (this.generations.get(environmentId) ?? 0) + 1);
    this.blockedEnvironments.add(environmentId);
    const entries = Array.from(this.byId.values()).filter(
      (entry) => entry.record.environmentId === environmentId,
    );
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.record.status === "running") await this.cancel(entry.record.id);
      }),
    );
    for (const entry of entries) this.remove(entry);
    this.blockedEnvironments.delete(environmentId);
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all(
      Array.from(this.byId.values()).map(async (entry) => {
        if (entry.record.status === "running") await this.cancel(entry.record.id);
      }),
    );
    for (const timer of this.pendingAnnounce.values()) clearTimeout(timer);
    this.pendingAnnounce.clear();
  }

  private require(id: string): Running {
    const entry = this.byId.get(id);
    if (!entry) throw new UserCommandError("not-found", "That command is not known.");
    return entry;
  }

  private add(key: string, entry: Running): void {
    const list = this.tabs.get(key) ?? [];
    list.push(entry);
    this.byId.set(entry.record.id, entry);
    // Keep the newest; never drop a running command or one the agent has not seen.
    while (list.length > USER_COMMAND_MAX_PER_TAB) {
      const index = list.findIndex(
        (candidate) =>
          candidate.record.status !== "running" && candidate.record.context.state !== "pending",
      );
      if (index === -1) break;
      const [dropped] = list.splice(index, 1);
      if (dropped) this.byId.delete(dropped.record.id);
    }
    this.tabs.set(key, list);
  }

  private remove(entry: Running): void {
    const key = tabKey(entry.record.environmentId, entry.record.tabId);
    const list = (this.tabs.get(key) ?? []).filter((candidate) => candidate !== entry);
    if (list.length === 0) this.tabs.delete(key);
    else this.tabs.set(key, list);
    this.byId.delete(entry.record.id);
    this.host.prompts.clear(entry.record.environmentId, this.promptId(entry));
    this.host.announce(entry.record.environmentId, entry.record.tabId);
  }

  private output(entry: Running, data: string): void {
    if (entry.record.status !== "running") return;
    const combined = entry.raw + data;
    if (combined.length > USER_COMMAND_OUTPUT_TAIL_CHARS) {
      entry.raw = combined.slice(-USER_COMMAND_OUTPUT_TAIL_CHARS);
      entry.rawTruncated = true;
    } else {
      entry.raw = combined;
    }
    this.scan(entry, entry.scanner.push(data));
    this.bump(entry);
    this.announce(entry, false);
  }

  private finish(
    entry: Running,
    outcome: { status: "exited" | "cancelled" | "failed"; exitCode?: number; error?: string },
  ): void {
    if (entry.record.status !== "running") return;
    entry.record.status = outcome.status;
    if (outcome.exitCode !== undefined) entry.record.exitCode = outcome.exitCode;
    if (outcome.error) entry.record.error = outcome.error.slice(0, 500);
    entry.record.endedAt = new Date(this.now()).toISOString();
    this.scan(entry, entry.scanner.finish());
    // The agent saw it running; it should also hear how it ended.
    if (entry.deliveredWhileRunning) entry.record.context = { state: "pending" };
    this.bump(entry);
    this.announce(entry, true);
  }

  private promptId(entry: Running): string {
    return `user-command:${entry.record.id}`;
  }

  private scan(entry: Running, change: ReturnType<HumanPromptScanner["push"]>): void {
    if (!change) return;
    if ("cleared" in change) {
      delete entry.record.prompt;
      this.host.prompts.clear(entry.record.environmentId, this.promptId(entry));
      return;
    }
    entry.record.prompt = change.prompt;
    this.host.prompts.set({
      id: this.promptId(entry),
      environmentId: entry.record.environmentId,
      tabId: entry.record.tabId,
      source: "user-command",
      userCommandId: entry.record.id,
      command: entry.record.command,
      prompt: change.prompt,
    });
  }

  private bump(entry: Running): void {
    entry.record.revision += 1;
  }

  private snapshot(entry: Running): UserCommandRecord {
    return {
      ...entry.record,
      context: { ...entry.record.context },
      output: normalizeTerminalText(entry.raw),
      outputTruncated: entry.rawTruncated,
    };
  }

  /** Coalesce output announcements; lifecycle edges go out at once. */
  private announce(entry: Running, immediate: boolean): void {
    const key = tabKey(entry.record.environmentId, entry.record.tabId);
    const pending = this.pendingAnnounce.get(key);
    if (immediate) {
      if (pending) clearTimeout(pending);
      this.pendingAnnounce.delete(key);
      this.host.announce(entry.record.environmentId, entry.record.tabId);
      return;
    }
    if (pending) return;
    const timer = setTimeout(() => {
      this.pendingAnnounce.delete(key);
      this.host.announce(entry.record.environmentId, entry.record.tabId);
    }, this.host.announceDelayMs ?? 200);
    timer.unref?.();
    this.pendingAnnounce.set(key, timer);
  }
}
