import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PromptQueueDrainer } from "../src/core/prompt-queue-drainer.js";
import { StorageService } from "../src/core/storage.js";

/**
 * Counts what delivering one agent-mail message to an idle claude-tmux tab
 * costs the backend (to-do 1202 task 8, report finding BG-15):
 *
 *   mise exec -- bun apps/backend/scripts/tmux-mail-inject-reads.ts [--deliveries 2000] [--json]
 *
 * Drives the real `PromptQueueDrainer` over a real `StorageService` in a
 * throwaway data directory, in the order the mail injector calls it: the
 * presence gate (`mailInjectPresence`), then the dispatch
 * (`dispatchMailInject`), which is handed the presence it follows. Only the
 * command invoker is a fake, standing in for the tab: it reports the session
 * running and idle and accepts the typed text. Reported per delivery: keyed
 * storage reads by kind, `claude_tmux_status` calls (fresh probes and ones
 * allowed to reuse the poll loop's recent answer), and wall time.
 *
 * Run it against another checkout's sources (a `git archive` of the base
 * commit unpacked under `output/`) for the before numbers: an older drainer
 * ignores the presence it is handed.
 */

const ENVIRONMENT_ID = "env-bench";
const TAB_ID = "tab-bench";

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} needs a positive integer`);
  return value;
}

type Counters = Record<string, number>;

function countCalls<T extends object>(target: T, methods: Array<keyof T>, counters: Counters) {
  for (const method of methods) {
    const original = target[method] as unknown as (...args: unknown[]) => unknown;
    (target as Record<keyof T, unknown>)[method] = (...args: unknown[]) => {
      counters[String(method)] = (counters[String(method)] ?? 0) + 1;
      return original.apply(target, args);
    };
  }
}

async function main(): Promise<void> {
  const deliveries = argument("--deliveries", 2000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orkestrator-mail-inject-reads-"));
  const counters: Counters = {};
  const durations: number[] = [];
  let storage: StorageService | undefined;
  let drainer: PromptQueueDrainer | undefined;
  try {
    storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: ENVIRONMENT_ID,
      projectId: "project-bench",
      name: "bench",
      branch: "main",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "full",
      order: 0,
      environmentType: "local",
      worktreePath: dataDir,
      setupScriptsComplete: true,
    });
    countCalls(
      storage,
      ["getEnvironment", "getPromptQueue", "getComposeDraft", "withEmptyPromptQueueForMail"],
      counters,
    );
    drainer = new PromptQueueDrainer(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
        if (command === "claude_tmux_status") {
          const kind = "livenessMaxAgeMs" in args ? "status (recent allowed)" : "status (fresh)";
          counters[kind] = (counters[kind] ?? 0) + 1;
          return { running: true, busy: false } as T;
        }
        counters[command] = (counters[command] ?? 0) + 1;
        return undefined as T;
      },
    );
    const target = { environmentId: ENVIRONMENT_ID, tabId: TAB_ID };
    for (let index = 0; index < deliveries; index += 1) {
      const started = performance.now();
      const presence = await drainer.mailInjectPresence(target);
      if (presence !== "idle") throw new Error(`presence ${presence}, expected idle`);
      const outcome = await drainer.dispatchMailInject({ ...target, text: "mail", presence });
      if (outcome.outcome !== "accepted") throw new Error(`dispatch ${JSON.stringify(outcome)}`);
      durations.push(performance.now() - started);
    }
  } finally {
    await drainer?.shutdown();
    storage?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  durations.sort((a, b) => a - b);
  const perDelivery = Object.fromEntries(
    Object.entries(counters)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => [name, count / deliveries]),
  );
  const keyedReads = ["getEnvironment", "getPromptQueue", "getComposeDraft"].reduce(
    (sum, name) => sum + (perDelivery[name] ?? 0),
    0,
  );
  const result = {
    deliveries,
    perDelivery,
    keyedReadsPerDelivery: keyedReads,
    wallMsP50: durations[Math.floor(durations.length * 0.5)] ?? 0,
    wallMsP95: durations[Math.floor(durations.length * 0.95)] ?? 0,
  };
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  console.log(`${deliveries} deliveries, bun ${Bun.version}, ${process.platform}`);
  for (const [name, count] of Object.entries(perDelivery))
    console.log(`${name.padEnd(30)} ${count.toFixed(2)}`);
  console.log(`${"keyed reads".padEnd(30)} ${keyedReads.toFixed(2)}`);
  console.log(
    `wall per delivery              p50 ${result.wallMsP50.toFixed(3)} ms, p95 ${result.wallMsP95.toFixed(3)} ms`,
  );
}

await main();
