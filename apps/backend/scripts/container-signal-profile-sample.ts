import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  WORKTREE_SNAPSHOT_CHANGED_EVENT,
  WORKTREE_SNAPSHOT_REVISIONS_COMMAND,
} from "@orkestrator/protocol/worktree-snapshots";

/**
 * Container observation costs on a running isolated `dev:test` profile:
 *
 *   mise run dev:test --profile <p> --fixture --fixture-environments local,container ...
 *   mise exec -- bun apps/backend/scripts/container-signal-profile-sample.ts \
 *     --profile <p> [--window-seconds 120] [--demote] [--out <file.json>]
 *
 * Against the profile's running container fixture, through its gateway:
 *
 * 1. `idle`: no reader. Execs per minute by recurring kind (Claude state
 *    reads, diff scans, tree walks).
 * 2. `panel`: a Files panel open on the container, reading the changed-file
 *    list and the tree every 5 s as the client does.
 * 3. `latency`: five file writes in the container; time to the worktree
 *    snapshot announcement and to a file-list read that shows the file.
 * 4. Signal health from recurring diagnostics, before and after.
 *
 * `--demote` first stops the container's worktree watcher (its `lost` ring
 * puts the container on the fallback bounds), which is how an image without
 * the signal behaves. Reads the gateway token from the profile's auth file
 * and only ever sends it as a header; output is content-free.
 */

type Kinds = Record<string, { started?: number }>;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const profile = argument("--profile");
if (!profile) throw new Error("--profile is required");
const windowMs = Number(argument("--window-seconds") ?? 120) * 1_000;
const profileRoot = path.join(
  os.platform() === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support")
    : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")),
  "orkestrator-v2-dev",
  "profiles",
  profile,
);
const status = JSON.parse(await readFile(path.join(profileRoot, "runtime", "status.json"), "utf8"));
const profileJson = JSON.parse(await readFile(path.join(profileRoot, "profile.json"), "utf8"));
const token: string = JSON.parse(await readFile(status.authFile, "utf8")).token;
const base = `http://${profileJson.gatewayHost}:${profileJson.gatewayPort}/__orkestrator`;
const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${base}/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify({ command, args }),
  });
  if (!response.ok) throw new Error(`${command} failed with ${response.status}`);
  const body = (await response.json()) as { result?: T } | T;
  return (body && typeof body === "object" && "result" in body ? body.result : body) as T;
}

async function metrics(): Promise<{ kinds: Kinds; signals: unknown }> {
  const response = await fetch(`${base}/metrics`, { headers });
  const body = (await response.json()) as {
    recurringWork: { metrics: { kinds: Kinds }; signals: unknown };
  };
  return { kinds: body.recurringWork.metrics.kinds, signals: body.recurringWork.signals };
}

const KINDS = ["tmux-poll", "diff-scan", "file-tree-read", "file-list-read", "git-fetch-container"];

function perMinute(before: Kinds, after: Kinds, elapsedMs: number): Record<string, number> {
  const result: Record<string, number> = {};
  for (const kind of KINDS) {
    const started = (after[kind]?.started ?? 0) - (before[kind]?.started ?? 0);
    result[kind] = Math.round((started * 60_000 * 10) / elapsedMs) / 10;
  }
  return result;
}

function docker(args: string[]): string {
  const result = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`docker ${args[0]} failed`);
  return result.stdout.toString().trim();
}

const projects = await invoke<Array<{ id: string }>>("get_projects");
let container: { id: string; containerId: string } | undefined;
for (const project of projects) {
  const environments = await invoke<
    Array<{ id: string; environmentType: string; status: string; containerId?: string | null }>
  >("get_environments", { projectId: project.id });
  const found = environments.find(
    (environment) =>
      environment.environmentType !== "local" &&
      environment.status === "running" &&
      environment.containerId,
  );
  if (found) container = { id: found.id, containerId: found.containerId! };
}
if (!container) throw new Error("No running container environment in the profile");
const { id: environmentId, containerId } = container;
const snapshot = await invoke<{
  entries: Array<{ environmentId: string; comparisonRef: string; fileListRevision: number }>;
}>(WORKTREE_SNAPSHOT_REVISIONS_COMMAND);
const comparisonRef =
  snapshot.entries.find((entry) => entry.environmentId === environmentId)?.comparisonRef ?? "main";

if (process.argv.includes("--demote")) {
  docker(["exec", containerId, "pkill", "-x", "inotifywait"]);
  await Bun.sleep(2_000);
}
const signalsBefore = (await metrics()).signals;

/** A conditional snapshot read: `{ unchanged, digest, value }`. */
const readList = () =>
  invoke<{ value?: Array<{ path: string }> } | Array<{ path: string }>>("get_git_status", {
    containerId,
    targetBranch: comparisonRef,
    includeUncommitted: true,
    knownDigest: "",
  });
const readTree = () => invoke<unknown>("get_file_tree", { containerId, knownDigest: "" });

// 1. Idle.
let before = await metrics();
let started = performance.now();
await Bun.sleep(windowMs);
let after = await metrics();
const idle = perMinute(before.kinds, after.kinds, performance.now() - started);

// 2. An open Files panel.
before = await metrics();
started = performance.now();
while (performance.now() - started < windowMs) {
  await Promise.all([readList(), readTree()]);
  await Bun.sleep(5_000);
}
after = await metrics();
const panel = perMinute(before.kinds, after.kinds, performance.now() - started);

// 3. Change-to-visible.
const events = await fetch(`${base}/events`, { headers });
const reader = events.body!.getReader();
const decoder = new TextDecoder();
let buffered = "";
let latestRevision = -1;
const revisionWaiters: Array<(revision: number) => void> = [];
void (async () => {
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffered += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffered.indexOf("\n\n")) !== -1) {
      const frame = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      try {
        const parsed = JSON.parse(data.slice(6)) as {
          event: string;
          payload: { environmentId?: string; fileListRevision?: number };
        };
        if (
          parsed.event === WORKTREE_SNAPSHOT_CHANGED_EVENT &&
          parsed.payload.environmentId === environmentId &&
          typeof parsed.payload.fileListRevision === "number"
        ) {
          latestRevision = parsed.payload.fileListRevision;
          for (const waiter of revisionWaiters.splice(0)) waiter(latestRevision);
        }
      } catch {
        // Not a frame this sampler reads.
      }
    }
  }
})();
const announcedMs: number[] = [];
const visibleMs: number[] = [];
const demote = process.argv.includes("--demote");
for (let attempt = 0; attempt < 5; attempt += 1) {
  // A lineage re-arms 5 min after a demotion; keep the fallback for every sample.
  if (demote) {
    Bun.spawnSync(["docker", "exec", containerId, "pkill", "-x", "inotifywait"]);
    await Bun.sleep(1_000);
  }
  const name = `signal-sample-${Date.now()}-${attempt}.txt`;
  const at = performance.now();
  let announced = false;
  revisionWaiters.push(() => {
    announced = true;
    announcedMs.push(Math.round(performance.now() - at));
  });
  docker(["exec", containerId, "sh", "-c", `echo sample > /workspace/${name}`]);
  // The client: a 5 s poll at a random phase, and a read on each announcement.
  let nextPollAt = at + Math.random() * 5_000;
  let readOnAnnouncement = false;
  while (performance.now() - at < 30_000) {
    const now = performance.now();
    const due = now >= nextPollAt || (announced && !readOnAnnouncement);
    if (due) {
      if (announced) readOnAnnouncement = true;
      if (now >= nextPollAt) nextPollAt += 5_000;
      const list = await readList();
      const changes = Array.isArray(list) ? list : (list.value ?? []);
      if (changes.some((change) => change.path === name)) {
        visibleMs.push(Math.round(performance.now() - at));
        break;
      }
    }
    await Bun.sleep(20);
  }
  revisionWaiters.length = 0;
  docker(["exec", containerId, "rm", "-f", `/workspace/${name}`]);
  // Let the removal be scanned and announced before the next sample starts:
  // a ring settles at once, the fallback waits for its 15 s scan.
  await Bun.sleep(demote ? 16_000 : 6_000);
}
await reader.cancel().catch(() => undefined);

const report = {
  at: new Date().toISOString(),
  profile,
  demoted: demote,
  windowSeconds: windowMs / 1_000,
  signalsBefore,
  signalsAfter: (await metrics()).signals,
  execsPerMinute: { idle, panel },
  latencyMs: {
    announced: announcedMs,
    visible: visibleMs,
    note: "announced = worktree snapshot event; visible = first client read (5 s poll at a random phase, or on announcement) that lists the file",
  },
};
const text = `${JSON.stringify(report, null, 2)}\n`;
const out = argument("--out");
if (out) await writeFile(out, text);
process.stdout.write(text);
process.exit(0);
