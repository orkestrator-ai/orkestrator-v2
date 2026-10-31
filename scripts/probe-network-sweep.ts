import { DOCKER_LABEL_RESOURCE_ROLE } from "../apps/backend/src/core/constants";
import { HOST_REACHABILITY_PROBE_ROLE } from "../apps/backend/src/core/container-host-reachability";

/**
 * Host-reachability probe networks of any owner (todo 0241 task 5). Each
 * backend's own reaper only removes its own owner's leftovers, so a probe
 * network leaked by a one-off data directory (a test backend killed
 * mid-check) is never revisited and holds one of the daemon's address pools.
 * A probe network holds no data and lives for one check, which takes seconds,
 * so one that is unattached and older than a day cannot belong to a running
 * check, whatever its owner.
 */

export type DockerRun = (
  command: string,
  args: string[],
) => { status: number | null; stdout: string };

export type ProbeNetwork = {
  id: string;
  name: string;
  createdAt: number | null;
  /** Containers in any state that name the network, or null when unknown. */
  containers: number | null;
};

export const PROBE_NETWORK_MIN_AGE_MS = 24 * 3_600_000;
/** The name `createProbeNetwork` gives it: `ork-<16 hex owner>-reach-probe-net`. */
const PROBE_NETWORK_NAME = /^ork-[0-9a-f]{16}-reach-probe-net$/;

function parseCreatedAt(value: string): number | null {
  // Docker's Go template prints time.Time as a Go time string rather than
  // RFC 3339. Normalize it explicitly instead of relying on Date.parse's
  // implementation-specific handling of spaces, nanoseconds and zone names.
  const goTime =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))? ([+-]\d{2})(\d{2}) \S+$/.exec(value);
  const normalized = goTime
    ? `${goTime[1]}T${goTime[2]}.${(goTime[3] ?? "").padEnd(3, "0").slice(0, 3)}${goTime[4]}:${goTime[5]}`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Probe networks by role label and exact name shape, or null when Docker cannot answer. */
export function listProbeNetworks(run: DockerRun): ProbeNetwork[] | null {
  const listed = run("docker", [
    "network",
    "ls",
    "--filter",
    `label=${DOCKER_LABEL_RESOURCE_ROLE}=${HOST_REACHABILITY_PROBE_ROLE}`,
    "--no-trunc",
    "--format",
    "{{.ID}} {{.Name}}",
  ]);
  if (listed.status !== 0) return null;
  const entries = listed.stdout
    .split("\n")
    .map((line) => line.trim().split(" "))
    .filter(
      (fields): fields is [string, string] =>
        fields.length === 2 &&
        /^[0-9a-f]{12,64}$/.test(fields[0]!) &&
        PROBE_NETWORK_NAME.test(fields[1]!),
    );
  return entries.map(([id, name]) => {
    const inspected = run("docker", ["network", "inspect", "--format", "{{.Created}}", id]);
    const createdAt = inspected.status === 0 ? parseCreatedAt(inspected.stdout.trim()) : null;
    // `network inspect` lists only running endpoints, so ask `ps -a` for
    // containers in every state. A never-started container matches only the
    // network's name, a started one its id; repeated filters are ORed.
    const attached = run("docker", [
      "ps",
      "-aq",
      "--filter",
      `network=${id}`,
      "--filter",
      `network=${name}`,
    ]);
    return {
      id,
      name,
      createdAt,
      containers: attached.status === 0 ? attached.stdout.split("\n").filter(Boolean).length : null,
    };
  });
}

/** Unattached probe networks older than `minAgeMs`; anything unknown is kept. */
export function staleProbeNetworks(
  networks: ProbeNetwork[],
  now: number,
  minAgeMs = PROBE_NETWORK_MIN_AGE_MS,
): ProbeNetwork[] {
  return networks.filter(
    (network) =>
      network.containers === 0 && network.createdAt !== null && now - network.createdAt > minAgeMs,
  );
}

/**
 * Removes each stale probe network, one per call so a refusal skips none. By
 * id, not name: its owner's next check removes and recreates the same name,
 * and that fresh network must not be the one removed.
 */
export function removeStaleProbeNetworks(
  run: DockerRun,
  now = Date.now(),
): { removed: string[]; failed: string[]; kept: number; unknown: number } | null {
  const networks = listProbeNetworks(run);
  if (networks === null) return null;
  const stale = staleProbeNetworks(networks, now);
  const unknown = networks.filter(
    (network) => network.createdAt === null || network.containers === null,
  ).length;
  const removed: string[] = [];
  const failed: string[] = [];
  for (const network of stale) {
    if (run("docker", ["network", "rm", network.id]).status === 0) removed.push(network.name);
    else failed.push(network.name);
  }
  return { removed, failed, kept: networks.length - stale.length - unknown, unknown };
}
