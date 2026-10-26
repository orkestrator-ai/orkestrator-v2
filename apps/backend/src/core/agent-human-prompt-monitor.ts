import { detectHumanPrompt, HUMAN_PROMPT_SCAN_BYTES } from "@orkestrator/protocol/human-prompts";

import type { HumanPromptRegistry } from "./human-prompt-registry.js";

/**
 * Watches agent shell commands for prompts that need the user.
 *
 * Bridges do not push tool output to the backend, so this reads it: every few
 * seconds, a short projection read of each working agent tab (bounded per
 * pass, round-robin), scanning
 * - shell tool calls still running, whose output the provider streams into
 *   the transcript (Codex, Pi, Cursor; OpenCode and Grok as they report it);
 * - background shell tasks still running. Their output is in a file the
 *   provider names (Claude: `tasks/<id>.output`). For a local environment the
 *   file is on this host and its tail is read directly; only paths in the
 *   provider's own task directories are ever opened.
 *
 * Each source's prompt goes to the shared registry and is cleared when the
 * call settles, the task ends, or the tab stops working. Output is never
 * logged.
 */

export interface MonitoredSession {
  environmentId: string;
  agent: string;
  logicalSessionKey: string;
  /** Local environments can have their task output files read on this host. */
  local: boolean;
}

export interface AgentHumanPromptMonitorDeps {
  prompts: HumanPromptRegistry;
  /** Agent tabs whose session is working now (turn or background work). */
  workingSessions(): Promise<MonitoredSession[]>;
  projection(session: MonitoredSession): Promise<{
    messages?: unknown;
    backgroundTasks?: unknown;
  } | null>;
  readFileTail(path: string, bytes: number): Promise<string | null>;
  intervalMs?: number;
  /** Sessions read per pass. */
  perPass?: number;
}

type Source = { id: string; output: string; command?: string };

/** The Claude CLI's task output files, and only those. */
const TASK_OUTPUT_FILE =
  /^(?:\/private)?\/tmp\/claude-\d+\/[^\0]+\/tasks\/[A-Za-z0-9_-]{1,64}\.output$/;
const OUTPUT_FILE_IN_TEXT =
  /Output is being written to:\s*((?:\/private)?\/tmp\/claude-\d+\/\S+\/tasks\/[A-Za-z0-9_-]{1,64}\.output)/;
const SHELL_TOOL = /^(bash|shell|sh|exec|exec_command|command|command_execution|terminal|run_terminal_cmd|local_shell|run_shell_command)$/i;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isTaskOutputFile(path: string): boolean {
  return TASK_OUTPUT_FILE.test(path) && !path.split("/").includes("..");
}

function shellCommand(part: Record<string, unknown>): string | undefined {
  const args = record(part.toolArgs) ? part.toolArgs : undefined;
  const command = args?.command ?? args?.cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.filter((item) => typeof item === "string").join(" ");
  return undefined;
}

/** Every part, depth first, including grouped and nested agent activity. */
function* walkParts(parts: unknown): Generator<Record<string, unknown>> {
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (!record(part)) continue;
    yield part;
    yield* walkParts(part.parts);
    yield* walkParts(part.childTools);
    if (record(part.task)) yield* walkParts([part.task]);
  }
}

/** Running shell calls and their output so far, from a projection's rows. */
export function runningShellSources(messages: unknown): Source[] {
  if (!Array.isArray(messages)) return [];
  const sources: Source[] = [];
  for (const message of messages) {
    if (!record(message)) continue;
    for (const part of walkParts(message.parts)) {
      if (part.toolState !== "pending" || typeof part.toolOutput !== "string") continue;
      const command = shellCommand(part);
      const name = typeof part.toolName === "string" ? part.toolName : "";
      if (!command && !SHELL_TOOL.test(name)) continue;
      const id =
        typeof part.toolUseId === "string"
          ? part.toolUseId
          : typeof part.id === "string"
            ? part.id
            : null;
      if (!id || !part.toolOutput) continue;
      sources.push({ id: `tool:${id}`, output: part.toolOutput, ...(command ? { command } : {}) });
    }
  }
  return sources;
}

/** Output files of running background tasks, keyed by task. */
export function runningTaskOutputFiles(
  messages: unknown,
  tasks: unknown,
  known: Map<string, { path: string; command?: string }> = new Map(),
): Array<{ id: string; path: string; command?: string }> {
  if (!Array.isArray(tasks)) return [];
  const launches = new Map<string, Record<string, unknown>>();
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!record(message)) continue;
      for (const part of walkParts(message.parts)) {
        if (typeof part.toolUseId === "string") launches.set(part.toolUseId, part);
      }
    }
  }
  const files: Array<{ id: string; path: string; command?: string }> = [];
  for (const task of tasks) {
    if (!record(task) || typeof task.id !== "string") continue;
    if (task.status !== "running" && task.status !== "pending") continue;
    if (task.kind !== undefined && task.kind !== "shell") continue;
    const launch = typeof task.toolUseId === "string" ? launches.get(task.toolUseId) : undefined;
    const fromLaunch =
      typeof launch?.toolOutput === "string"
        ? OUTPUT_FILE_IN_TEXT.exec(launch.toolOutput)?.[1]
        : undefined;
    // The launch row scrolls out of a short read; remember what it said.
    const remembered = known.get(task.id);
    const path =
      (typeof task.outputFile === "string" ? task.outputFile : fromLaunch) ?? remembered?.path;
    if (!path || !isTaskOutputFile(path)) continue;
    const command =
      (launch ? shellCommand(launch) : undefined) ??
      remembered?.command ??
      (typeof task.description === "string" ? task.description : undefined);
    known.set(task.id, { path, ...(command ? { command } : {}) });
    files.push({ id: `task:${task.id}`, path, ...(command ? { command } : {}) });
  }
  return files;
}

export class AgentHumanPromptMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cursor = 0;
  /** Output files of background tasks seen running, by task id (bounded). */
  private readonly taskFiles = new Map<string, { path: string; command?: string }>();
  /** Sources with a prompt, per tab, so the ones that went away are cleared. */
  private readonly live = new Map<string, { environmentId: string; tabId: string; ids: Set<string> }>();

  constructor(private readonly deps: AgentHumanPromptMonitorDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass; exported for tests. Never overlaps itself. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sessions = (await this.deps.workingSessions().catch(() => [])).filter(
        (session) =>
          !session.environmentId.startsWith("coordinator:") &&
          session.logicalSessionKey.startsWith(`env-${session.environmentId}:`),
      );
      const working = new Set(sessions.map((session) => session.logicalSessionKey));
      // A tab that stopped working has nothing waiting any more.
      for (const [key, entry] of Array.from(this.live)) {
        if (working.has(key)) continue;
        for (const id of entry.ids) this.deps.prompts.clear(entry.environmentId, id);
        this.live.delete(key);
      }
      if (sessions.length === 0) return;
      const perPass = Math.min(sessions.length, this.deps.perPass ?? 8);
      for (let index = 0; index < perPass; index += 1) {
        const session = sessions[(this.cursor + index) % sessions.length]!;
        await this.scanSession(session).catch(() => undefined);
      }
      this.cursor = (this.cursor + perPass) % sessions.length;
    } finally {
      this.running = false;
    }
  }

  private async scanSession(session: MonitoredSession): Promise<void> {
    const tabId = session.logicalSessionKey.slice(`env-${session.environmentId}:`.length);
    const projection = await this.deps.projection(session);
    if (!projection) return;
    const sources: Array<Source & { kind: "agent-tool" | "agent-background-task" }> =
      runningShellSources(projection.messages).map((source) => ({
        ...source,
        kind: "agent-tool" as const,
      }));
    if (session.local) {
      const files = runningTaskOutputFiles(
        projection.messages,
        projection.backgroundTasks,
        this.taskFiles,
      );
      while (this.taskFiles.size > 256) {
        const oldest = this.taskFiles.keys().next().value;
        if (oldest === undefined) break;
        this.taskFiles.delete(oldest);
      }
      for (const file of files) {
        const output = await this.deps.readFileTail(file.path, HUMAN_PROMPT_SCAN_BYTES);
        if (output) {
          sources.push({
            id: file.id,
            output,
            ...(file.command ? { command: file.command } : {}),
            kind: "agent-background-task",
          });
        }
      }
    }
    const previous = this.live.get(session.logicalSessionKey)?.ids ?? new Set<string>();
    const current = new Set<string>();
    for (const source of sources) {
      const prompt = detectHumanPrompt(source.output);
      if (!prompt) continue;
      current.add(source.id);
      this.deps.prompts.set({
        id: source.id,
        environmentId: session.environmentId,
        tabId,
        source: source.kind,
        prompt,
        ...(source.command ? { command: source.command } : {}),
      });
    }
    for (const id of previous) {
      if (!current.has(id)) this.deps.prompts.clear(session.environmentId, id);
    }
    if (current.size > 0) {
      this.live.set(session.logicalSessionKey, {
        environmentId: session.environmentId,
        tabId,
        ids: current,
      });
    } else {
      this.live.delete(session.logicalSessionKey);
    }
  }
}
