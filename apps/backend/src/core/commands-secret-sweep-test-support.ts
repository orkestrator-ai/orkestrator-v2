/**
 * Child process for `commands-secret-sweep.test.ts`: calls every registered
 * backend command against a private data directory whose stored credentials
 * are canaries, and writes one line per call saying whether a canary reached
 * the caller.
 *
 * It runs in its own process, started by the test with a constructed
 * environment (temporary HOME and XDG directories, a PATH holding no
 * programs, no inherited `ORKESTRATOR_*` variable), so a command that reaches
 * for the host finds nothing there, and whatever background work a command
 * leaves behind dies with this process instead of outliving the test.
 *
 * Usage: bun commands-secret-sweep-test-support.ts <root> <result-file>
 */
import { eventSink } from "./backend-emit.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AUTH_SECRET_CANARIES } from "../../../../tests/helpers/auth-secret-canaries.js";

/** Marker carried by every canary; see `tests/helpers/auth-secret-canaries.ts`. */
const MARK = "ORKCANARY";
/** An uninspected response fails the sweep; it must never count as coverage. */
const CALL_TIMEOUT_MS = 2_000;

/**
 * `empty` sends no arguments; `seeded` names the seeded project, environment
 * and a tab; `shaped` adds the settings-style bodies config writers take, so
 * those get past validation and answer.
 */
export type SweepVariant = "empty" | "seeded" | "shaped";
export type SweepRecord = {
  command: string;
  variant: SweepVariant;
  outcome: "resolved" | "rejected";
  /** Where a canary appeared: the answer, the error, or an event emitted during the call. */
  leaks: Array<"result" | "error" | "event">;
};

/** The stored credentials the global config can hold, each set to a canary. */
export const STORED_SECRET_CANARIES = {
  githubToken: AUTH_SECRET_CANARIES.githubToken,
  anthropicApiKey: AUTH_SECRET_CANARIES.anthropicApiKey,
  cursorApiKey: AUTH_SECRET_CANARIES.cursorApiKey,
  openCodeZenApiKey: AUTH_SECRET_CANARIES.openCodeZenApiKey,
} as const;

/** Retries allowed per call for dropping the fields a command refused. */
const MAX_FIELD_RETRIES = 12;

/** Fields of `args` a validation error says the command does not accept. */
function unexpectedFields(error: unknown, args: Record<string, unknown>): string[] {
  const message = error instanceof Error ? error.message : "";
  const match = /(?:Unexpected .*?field|Unknown arguments?|Unknown fields?):\s*(.+)$/i.exec(
    message,
  );
  if (!match?.[1]) return [];
  return match[1]
    .split(/[,\s]+/)
    .map((field) => field.replace(/[^\w.-]/g, ""))
    .filter((field) => Object.hasOwn(args, field));
}

function serialize(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, entry: unknown) => {
        if (typeof entry === "bigint") return entry.toString();
        if (entry instanceof Error) {
          return { ...entry, name: entry.name, message: entry.message, cause: entry.cause };
        }
        if (entry && typeof entry === "object") {
          if (seen.has(entry)) return "[circular]";
          seen.add(entry);
        }
        return entry;
      }) ?? ""
    );
  } catch {
    return String(value);
  }
}

export function settleWithin(
  work: () => unknown,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<{
  outcome: SweepRecord["outcome"];
  value?: unknown;
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`secret sweep response uninspected after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const finish = (result: { outcome: SweepRecord["outcome"]; value?: unknown }) => {
      clearTimeout(timer);
      resolve(result);
    };
    try {
      Promise.resolve(work()).then(
        (value) => finish({ outcome: "resolved", value }),
        (error: unknown) => finish({ outcome: "rejected", value: error }),
      );
    } catch (error) {
      finish({ outcome: "rejected", value: error });
    }
  });
}

async function main(root: string, resultFile: string): Promise<void> {
  // No command may reach the network from here: a GitHub call would carry the
  // planted token, and the production backend shares this host.
  globalThis.fetch = (async () => {
    throw new Error("network is disabled in the secret sweep");
  }) as unknown as typeof fetch;

  const { createCommandRegistry } = await import("./commands.js");
  const { StorageService, createProject } = await import("./storage.js");
  const { createEnvironment } = await import("./storage-shared-core.js");
  const { EnvironmentLifecycleTaskTracker } = await import("./environment-lifecycle-tasks.js");
  const { BackendRuntime } = await import("./backend-runtime.js");

  const projectPath = path.join(root, "project");
  await fs.mkdir(projectPath, { recursive: true });
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  await storage.patchGlobalConfig({ ...STORED_SECRET_CANARIES });

  const project = createProject("https://github.com/example/sweep.git", projectPath);
  await storage.addProject(project);
  const environment = {
    ...createEnvironment(project.id, { name: "sweep", environmentType: "local" }),
    worktreePath: projectPath,
  };
  await storage.addEnvironment(environment);
  // Restores what an earlier delete removed, so later commands still find them.
  const reseed = async () => {
    if (!(await storage.getProject(project.id))) await storage.addProject({ ...project });
    if (!(await storage.getEnvironment(environment.id))) {
      await storage.addEnvironment({ ...environment });
    }
    await storage.patchGlobalConfig({ ...STORED_SECRET_CANARIES });
  };

  const events: string[] = [];
  const emit = eventSink((event, payload) => {
    events.push(`${event} ${serialize(payload)}`);
  });
  const context = {
    storage,
    emit,
    appRoot: path.join(root, "app"),
    resourceRoot: path.join(root, "resources"),
    worktreeDir: path.join(root, "worktrees"),
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    runtime: new BackendRuntime({ emit }),
  } as unknown as import("./commands-context.js").CommandContext;

  const commands = createCommandRegistry();
  // What a client holds after loading settings, sent back the way a settings
  // save does. The read is redacted, and is itself swept below.
  const clientConfig = await commands.get("get_config")!({}, context);
  const clientGlobal = (clientConfig as { global: unknown }).global;
  const seeded = { projectId: project.id, environmentId: environment.id, tabId: "sweep-tab" };
  const variants: Array<[SweepVariant, Record<string, unknown>]> = [
    ["empty", {}],
    ["seeded", seeded],
    [
      "shaped",
      {
        ...seeded,
        settings: {},
        patch: {},
        global: clientGlobal,
        config: clientConfig,
        enabled: true,
        paused: false,
        dismissed: false,
      },
    ],
  ];
  const records: SweepRecord[] = [];
  for (const [variant, variantArgs] of variants) {
    for (const name of Array.from(commands.keys()).sort()) {
      if (variant !== "empty") await reseed();
      const handler = commands.get(name)!;
      const leaks = new Set<SweepRecord["leaks"][number]>();
      const args = { ...variantArgs };
      let settled: Awaited<ReturnType<typeof settleWithin>>;
      // A command that refuses fields it does not take names them; retry
      // without those, so strict commands are reached past validation too.
      for (let attempt = 0; ; attempt += 1) {
        events.length = 0;
        try {
          settled = await settleWithin(() => handler({ ...args }, context));
        } catch (cause) {
          throw new Error(`secret sweep incomplete: ${name} (${variant})`, { cause });
        }
        if (serialize(settled.value).includes(MARK)) {
          leaks.add(settled.outcome === "resolved" ? "result" : "error");
        }
        if (events.some((line) => line.includes(MARK))) leaks.add("event");
        const refused = settled.outcome === "rejected" ? unexpectedFields(settled.value, args) : [];
        if (refused.length === 0 || attempt >= MAX_FIELD_RETRIES) break;
        for (const field of refused) delete args[field];
      }
      records.push({ command: name, variant, outcome: settled.outcome, leaks: Array.from(leaks) });
    }
  }
  await fs.writeFile(resultFile, JSON.stringify(records));
}

if (import.meta.main) {
  const [root, resultFile] = process.argv.slice(2);
  if (!root || !resultFile) throw new Error("usage: <root> <result-file>");
  await main(root, resultFile);
  // Background work some commands start must not keep the sweep alive.
  process.exit(0);
}
