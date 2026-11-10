/**
 * Runs one model call through Claude Code in print mode, on the account
 * Orkestrator has active for Claude. The call has no tools, no MCP servers, no slash
 * commands, no settings files and no saved session, runs in the state
 * directory (so no project instructions load), and must return JSON matching
 * the given schema.
 */
import { spawn } from "node:child_process";
import { SELF_IMPROVEMENT_MODELS } from "@orkestrator/protocol/self-improvement";

/** Reads each conversation part. */
export const NOTES_MODEL = SELF_IMPROVEMENT_MODELS.notes;
/** Groups notes into themes across conversations. */
export const THEMES_MODEL = SELF_IMPROVEMENT_MODELS.themes;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MODEL_TIMEOUT_MS = 10 * 60 * 1000;

export interface ModelCall {
  model: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
}

export interface ModelResult<T> {
  output: T;
  costUsd: number;
}

export type ModelRunner = <T>(call: ModelCall) => Promise<ModelResult<T>>;

export function claudeArgs(call: ModelCall): string[] {
  return [
    "-p",
    "--model",
    call.model,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(call.schema),
    "--system-prompt",
    call.system,
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--no-session-persistence",
  ];
}

/** Reads Claude Code's `--output-format json` result. */
export function parseClaudeResult<T>(stdout: string): ModelResult<T> {
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error("Claude Code did not return a JSON result.");
  }
  if (result.is_error === true || result.subtype !== "success") {
    const detail = typeof result.subtype === "string" ? result.subtype : "error";
    throw new Error(`Claude Code reported ${detail}.`);
  }
  if (result.structured_output === undefined || result.structured_output === null) {
    throw new Error("Claude Code returned no structured output.");
  }
  return {
    output: result.structured_output as T,
    costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0,
  };
}

export interface ClaudeCodeLaunch {
  /** The state directory: no project instructions load from it. */
  cwd: string;
  executable: string;
  env: NodeJS.ProcessEnv;
  /** Aborts every call in flight, for a backend that is stopping. */
  signal?: AbortSignal;
}

export function claudeCodeRunner(launch: ClaudeCodeLaunch): ModelRunner {
  const { cwd, env, signal } = launch;
  const command = launch.executable;
  return <T>(call: ModelCall) =>
    new Promise<ModelResult<T>>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("The backend is stopping."));
        return;
      }
      const child = spawn(command, claudeArgs(call), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      const onAbort = () => {
        child.kill("SIGTERM");
        finish(new Error("The backend is stopping."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = "";
      let settled = false;
      const finish = (error: Error | null, value?: ModelResult<T>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value!);
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(new Error(`Claude Code took longer than ${MODEL_TIMEOUT_MS / 60000} minutes.`));
      }, MODEL_TIMEOUT_MS);
      child.on("error", (error: NodeJS.ErrnoException) =>
        finish(
          new Error(
            error.code === "ENOENT"
              ? "Claude Code is not installed: install it from Settings → Claude, or turn off the conversation review."
              : `Could not run ${command}: ${error.message}`,
          ),
        ),
      );
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes <= MAX_OUTPUT_BYTES) chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString("utf8");
      });
      child.on("close", (code) => {
        const stdout = Buffer.concat(chunks).toString("utf8");
        if (code !== 0 && !stdout.trim()) {
          finish(
            new Error(`Claude Code exited with ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`),
          );
          return;
        }
        try {
          finish(null, parseClaudeResult<T>(stdout));
        } catch (error) {
          finish(error as Error);
        }
      });
      child.stdin.on("error", () => {
        // A child that exits early closes stdin; its exit reports the failure.
      });
      child.stdin.end(call.prompt);
    });
}
