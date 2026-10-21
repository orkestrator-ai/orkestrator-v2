/**
 * Federated-client benchmark fixtures (remote.md section 17).
 *
 * Synthetic, in-process fake backends only: no backend, network, prompt,
 * file or terminal data is involved. For 1/3/10/25 configured machines with
 * 200 environments each — one deliberately slow machine (300 ms per read)
 * and one unreachable machine — it measures, for the renderer's runtime
 * registry:
 *   - time until the first machine's summaries are usable,
 *   - time until every reachable machine is current,
 *   - summary reads issued (no transcript reads are allowed),
 *   - retained summary size per machine (serialized),
 *   - leftover subscriptions after 50 sync/dispose cycles.
 *
 * It does not measure the Electron IPC hop, real gateways, encoded bytes on
 * the wire, detail panes or streaming terminals; those need the real-stack
 * matrix and are reported as not measured.
 *
 * Run: bun scripts/benchmark-federation.ts [--json]
 * Single-machine timings are evidence for this host only, not thresholds.
 */
import type { ConnectionList, ConnectionSummary } from "@orkestrator/protocol/connections";
import type { BackendId } from "@orkestrator/protocol/federation";
import type {
  BackendClient,
  BackendEventListener,
} from "../apps/web/src/lib/federation/backend-client";
import { BackendClientRegistry } from "../apps/web/src/lib/federation/registry";

const MACHINE_COUNTS = [1, 3, 10, 25];
const ENVIRONMENTS_PER_MACHINE = 200;
const PROJECTS_PER_MACHINE = 10;
const SLOW_READ_MS = 300;
const json = process.argv.includes("--json");

type Counters = { reads: number; transcriptReads: number; subscriptions: number };

function fakeMachine(
  index: number,
  counters: Counters,
  mode: "fast" | "slow" | "down",
): BackendClient {
  const projects = Array.from({ length: PROJECTS_PER_MACHINE }, (_, project) => ({
    id: `project-${project}`,
    name: `Project ${project}`,
    order: project,
  }));
  const perProject = ENVIRONMENTS_PER_MACHINE / PROJECTS_PER_MACHINE;
  const listeners = new Set<BackendEventListener>();
  return {
    connectionId: `machine-${index}`,
    async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
      counters.reads += 1;
      if (/transcript|message|session_history/.test(command)) counters.transcriptReads += 1;
      if (mode === "down") throw new TypeError("fetch failed");
      if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, SLOW_READ_MS));
      if (command === "get_projects") return projects as T;
      if (command === "get_environment_snapshots") {
        return Array.from({ length: perProject }, (_, environment) => ({
          // Deliberately identical local IDs on every machine.
          id: `environment-${environment}`,
          projectId: args.projectId,
          name: `Environment ${environment}`,
          status: "running",
          agentActivityState: environment % 3 === 0 ? "working" : "idle",
        })) as T;
      }
      return undefined as T;
    },
    subscribe(listener) {
      counters.subscriptions += 1;
      listeners.add(listener);
      return () => {
        counters.subscriptions -= 1;
        listeners.delete(listener);
      };
    },
    observe: async () => null,
    release: () => undefined,
  };
}

function list(count: number): ConnectionList {
  const connections: ConnectionSummary[] = Array.from({ length: count }, (_, index) => ({
    id: `machine-${index}`,
    name: `Machine ${index}`,
    address: `https://machine-${index}.example`,
    kind: "remote",
    active: false,
    requiresToken: false,
    backendId: `bk_${index}` as BackendId,
    identity: "verified",
    transport: "connected",
  }));
  return {
    activeConnectionId: "local",
    connections: [
      {
        id: "local",
        name: "Local",
        address: null,
        kind: "local",
        active: true,
        requiresToken: false,
      },
      ...connections,
    ],
  };
}

function modeFor(index: number, count: number): "fast" | "slow" | "down" {
  if (count >= 3 && index === count - 1) return "down";
  if (count >= 3 && index === count - 2) return "slow";
  return "fast";
}

async function measure(count: number) {
  const counters: Counters = { reads: 0, transcriptReads: 0, subscriptions: 0 };
  const started = performance.now();
  const registry = new BackendClientRegistry((connection) =>
    fakeMachine(
      Number(connection.id.split("-")[1]),
      counters,
      modeFor(Number(connection.id.split("-")[1]), count),
    ),
  );
  registry.sync(list(count), { enabled: true });
  let firstUsableMs: number | null = null;
  const reachable = registry
    .list()
    .filter((runtime) => modeFor(Number(runtime.connectionId.split("-")[1]), count) !== "down");
  await new Promise<void>((resolve) => {
    const check = () => {
      const loaded = reachable.filter((runtime) => runtime.getSnapshot().loadedAt !== null);
      if (firstUsableMs === null && loaded.length > 0) firstUsableMs = performance.now() - started;
      if (loaded.length === reachable.length) resolve();
      else setTimeout(check, 1);
    };
    check();
  });
  const allCurrentMs = performance.now() - started;
  await Promise.all(registry.list().map((runtime) => runtime.whenIdle()));
  // Retained summary size, as serialized bytes: a stable, content-free
  // proxy (in-process heap deltas at this scale are dominated by GC noise).
  const summaryKiBPerMachine =
    registry.list().reduce((total, runtime) => {
      const snapshot = runtime.getSnapshot();
      return (
        total +
        JSON.stringify({
          projects: snapshot.projects,
          environments: Array.from(snapshot.environmentsByProject.values()),
        }).length
      );
    }, 0) /
    1024 /
    Math.max(1, reachable.length);
  const environments = registry
    .list()
    .reduce(
      (total, runtime) =>
        total +
        Array.from(runtime.getSnapshot().environmentsByProject.values()).reduce(
          (sum, rows) => sum + rows.length,
          0,
        ),
      0,
    );
  registry.dispose();
  const hydrationReads = counters.reads;
  const hydrationTranscriptReads = counters.transcriptReads;
  // Repeated connect/disconnect cycles must not accumulate subscriptions.
  const churnCounters: Counters = { reads: 0, transcriptReads: 0, subscriptions: 0 };
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const churn = new BackendClientRegistry((connection) =>
      fakeMachine(Number(connection.id.split("-")[1]), churnCounters, "fast"),
    );
    churn.sync(list(count), { enabled: true });
    churn.dispose();
  }
  return {
    machines: count,
    environmentsLoaded: environments,
    firstUsableMs: Math.round(firstUsableMs ?? allCurrentMs),
    allReachableCurrentMs: Math.round(allCurrentMs),
    summaryReads: hydrationReads,
    transcriptReads: hydrationTranscriptReads,
    summaryKiBPerMachine: Math.round(summaryKiBPerMachine),
    leakedSubscriptions: counters.subscriptions + churnCounters.subscriptions,
  };
}

const results = [];
for (const count of MACHINE_COUNTS) results.push(await measure(count));

if (json) {
  console.log(JSON.stringify({ results }, null, 2));
} else {
  console.log(
    `Federated runtime fixture: ${ENVIRONMENTS_PER_MACHINE} environments per machine; one slow (${SLOW_READ_MS} ms/read) and one unreachable machine from 3 machines up.`,
  );
  console.table(results);
}
