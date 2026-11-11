import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Counts the `docker exec`s one claude-tmux tab's poll loop costs, by kind,
 * over simulated time against a fake container (to-do 1202 task 8):
 *
 *   mise exec -- bun apps/backend/scripts/tmux-exec-count.ts [--src <apps/backend/src>]
 *     [--seconds 60] [--json]
 *
 * The real `TmuxSession` and `TmuxBackend` run; only the process spawn is
 * replaced, so every exec the loop issues is counted. `--src` points at
 * another checkout's backend sources (for example a `git archive` of `main`
 * unpacked under `output/`), which is how the before numbers are taken.
 * Scenarios with a confirmed hook doorbell are reported as `n/a` for sources
 * that have none.
 */

export type ExecKind =
  "snapshot" | "has-session" | "capture-pane" | "discovery" | "transcript-read" | "other";

export type Scenario = {
  name: string;
  /** The tab has a transcript (it has had a prompt). */
  bound: boolean;
  /** A turn is running. */
  busy: boolean;
  /** The container's hook doorbell is confirmed. */
  doorbell: boolean;
  /** Rings produced by a busy sibling sharing this container. */
  siblingRings?: boolean;
};

export const SCENARIOS: readonly Scenario[] = [
  { name: "idle bound tab, no doorbell (older image)", bound: true, busy: false, doorbell: false },
  { name: "idle bound tab, doorbell confirmed", bound: true, busy: false, doorbell: true },
  {
    name: "idle unbound tab, no doorbell (older image)",
    bound: false,
    busy: false,
    doorbell: false,
  },
  { name: "idle unbound tab, doorbell confirmed", bound: false, busy: false, doorbell: true },
  {
    name: "idle sibling of a busy ringing tab",
    bound: true,
    busy: false,
    doorbell: true,
    siblingRings: true,
  },
  { name: "busy tab (turn running)", bound: true, busy: true, doorbell: false },
];

export type ExecCounts = Record<ExecKind, number> & { total: number };

/**
 * A recurring-work recorder (`RecurringWorkMetrics`). When given, the session
 * reports its ticks into it, and every fake exec is charged as the
 * `docker exec` the real capture boundary would charge (todo 7567).
 */
export type ExecMetrics = { work(unit: "docker-exec", count?: number): void };

type SessionModule = {
  TmuxSession: new (
    environmentId: string,
    tabId: string,
    backend: unknown,
    runtimeRootPrefix: string,
    resumeSessionId?: string,
    claudeCommand?: string,
    timing?: { pollTick?: (intervalMs: number) => Promise<void>; metrics?: ExecMetrics },
  ) => Record<string, unknown>;
};
type BackendModule = { TmuxBackend: { container(id: string): Record<string, unknown> } };

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const TRANSCRIPT_LINE = `${JSON.stringify({ sessionId: SESSION_ID, type: "user" })}\n`;
const SIBLINGS = ["aaaaaaaa", "bbbbbbbb"].map(
  (name) => `/home/node/.claude/projects/-workspace/${name}.jsonl`,
);

function classify(args: string[]): ExecKind {
  const script = args[0] === "sh" && args[1] === "-c" ? (args[2] ?? "") : "";
  if (script.includes("__ork_pending__")) return "snapshot";
  if (args[0] === "tmux" && args[1] === "has-session") return "has-session";
  if (args[0] === "tmux" && args[1] === "capture-pane") return "capture-pane";
  if (script.includes("tail -c") || script.includes("dd ")) return "transcript-read";
  if (
    script.includes("find ") ||
    script.includes("stat -c %s") ||
    args[0] === "test" ||
    args[0] === "cat" ||
    args[0] === "head"
  ) {
    return "discovery";
  }
  return "other";
}

/** What the fake container answers; enough for every exec the loop issues. */
function answer(args: string[], scenario: Scenario): { status: number; stdout: string } {
  const transcript = `/home/node/.claude/projects/-workspace/${SESSION_ID}.jsonl`;
  const script = args[0] === "sh" && args[1] === "-c" ? (args[2] ?? "") : "";
  if (script.includes("__ork_pending__")) {
    const lines = ["__ork_pending__", "__ork_timeout__", "__ork_size__"];
    lines.push(script.includes("stat -c %s") && scenario.bound ? `${TRANSCRIPT_LINE.length}` : "0");
    if (script.includes("__ork_candidate__")) {
      lines.push("__ork_candidate__", scenario.bound ? `${TRANSCRIPT_LINE.length}` : "missing");
    }
    if (script.includes("__ork_alive__")) lines.push("__ork_alive__", "1");
    let stdout = `${lines.join("\n")}\n`;
    const pane = /__ork_pane_([A-Za-z0-9]+)__/.exec(script);
    if (pane) stdout += `__ork_pane_${pane[1]}__\n> \n\n__ork_pane_end_${pane[1]}__ 0\n`;
    return { status: 0, stdout };
  }
  if (args[0] === "tmux" && args[1] === "has-session") return { status: 0, stdout: "" };
  if (args[0] === "tmux" && args[1] === "capture-pane") return { status: 0, stdout: "> \n" };
  if (script.includes("find ")) {
    return { status: 0, stdout: SIBLINGS.map((file) => `1700000000 ${file}\0`).join("") };
  }
  if (script.includes("stat -c %s")) {
    return { status: 0, stdout: script.includes(transcript) && scenario.bound ? "64\n" : "0\n" };
  }
  if (script.includes("tail -c")) return { status: 0, stdout: TRANSCRIPT_LINE };
  if (args[0] === "test") {
    const exists = SIBLINGS.includes(args[2] ?? "") || (scenario.bound && args[2] === transcript);
    return { status: exists ? 0 : 1, stdout: "" };
  }
  if (args[0] === "cat" || args[0] === "head") {
    const file = args.at(-1) ?? "";
    if (file === transcript) return { status: 0, stdout: TRANSCRIPT_LINE };
    return { status: 0, stdout: `${JSON.stringify({ sessionId: "someone-else" })}\n` };
  }
  return { status: 0, stdout: "" };
}

/**
 * Runs one tab's poll loop for `seconds` of simulated time and counts execs.
 * Returns null for a doorbell scenario on sources without a doorbell.
 */
export async function measureTmuxExecs(
  sessionModule: SessionModule,
  backendModule: BackendModule,
  scenario: Scenario,
  seconds: number,
  options: { metrics?: ExecMetrics } = {},
): Promise<ExecCounts | null> {
  const counts: ExecCounts = {
    snapshot: 0,
    "has-session": 0,
    "capture-pane": 0,
    discovery: 0,
    "transcript-read": 0,
    other: 0,
    total: 0,
  };
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  const timers: Array<{ due: number; resolve: () => void }> = [];
  const backend = backendModule.TmuxBackend.container("c".repeat(64));
  const record = (args: string[]) => {
    const kind = classify(args);
    options.metrics?.work("docker-exec");
    counts[kind] += 1;
    counts.total += 1;
    return answer(args, scenario);
  };
  backend.exec = async (args: string[]) => ({ ...record(args), stderr: "" });
  backend.execRaw = async (args: string[]) => {
    const out = record(args);
    return { status: out.status, stdout: Buffer.from(out.stdout), stderr: "" };
  };
  let attached = false;
  let rings = 0;
  let ringListener: (() => void) | undefined;
  const doorbell = {
    rings: () => rings,
    confirmed: () => scenario.doorbell,
    missed: () => undefined,
    release: () => undefined,
  };
  const context = {
    emit: () => undefined,
    storage: {},
    runtime: {
      tmux: {
        sessions: { installLock: () => ({ runExclusive: async () => undefined }) },
        persistEnvironmentActivity: async () => undefined,
        hookSignals: {
          attach: (_id: string, _context: unknown, onRing: () => void) => {
            ringListener = onRing;
            attached = true;
            return doorbell;
          },
        },
      },
    },
  };
  const session = new sessionModule.TmuxSession(
    "env",
    "tab",
    backend,
    "/tmp/orkestrator-exec-count",
    // A fresh tab gets its own id, which no transcript in the fake container has.
    scenario.bound ? SESSION_ID : undefined,
    undefined,
    {
      pollTick: (intervalMs) =>
        new Promise<void>((resolve) => timers.push({ due: now + intervalMs, resolve })),
      ...(options.metrics ? { metrics: options.metrics } : {}),
    },
  );
  (session as { busy: boolean }).busy = scenario.busy;
  const settle = async () => {
    for (let index = 0; index < 20; index += 1) await new Promise((r) => setImmediate(r));
  };
  try {
    (session as unknown as { spawnPollLoop(context: unknown): void }).spawnPollLoop(context);
    await settle();
    const end = now + seconds * 1_000;
    const siblingRing = () => {
      rings++;
      ringListener?.();
      timers.push({ due: now + 250, resolve: siblingRing });
    };
    if (scenario.siblingRings) timers.push({ due: now + 250, resolve: siblingRing });
    while (now < end) {
      timers.sort((left, right) => left.due - right.due);
      const next = timers.shift();
      if (!next) break;
      now = Math.max(now, next.due);
      next.resolve();
      await settle();
    }
  } finally {
    (session as { stopRequested: boolean }).stopRequested = true;
    for (const timer of timers.splice(0)) timer.resolve();
    await settle();
    Date.now = realNow;
  }
  if (scenario.doorbell && !attached) return null;
  return counts;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const src = path.resolve(argument("--src") ?? path.join(import.meta.dir, "../src"));
  const seconds = Number(argument("--seconds") ?? 60);
  const sessionModule = (await import(
    pathToFileURL(path.join(src, "core/tmux-session-manager.ts")).href
  )) as SessionModule;
  const backendModule = (await import(
    pathToFileURL(path.join(src, "core/tmux-backend.ts")).href
  )) as BackendModule;
  const rows: Array<{ scenario: string; counts: ExecCounts | null }> = [];
  for (const scenario of SCENARIOS) {
    rows.push({
      scenario: scenario.name,
      counts: await measureTmuxExecs(sessionModule, backendModule, scenario, seconds),
    });
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ src, seconds, rows }, null, 2));
    return;
  }
  console.log(`docker execs per tab over ${seconds} s (${src})`);
  for (const { scenario, counts } of rows) {
    if (!counts) {
      console.log(`${scenario}: n/a`);
      continue;
    }
    const perSecond = (counts.total / seconds).toFixed(2);
    const kinds = (Object.keys(counts) as Array<keyof ExecCounts>)
      .filter((kind) => kind !== "total" && counts[kind] > 0)
      .map((kind) => `${kind} ${counts[kind]}`)
      .join(", ");
    console.log(`${scenario}: ${counts.total} (${perSecond}/s) — ${kinds}`);
  }
}

if (import.meta.main) await main();
