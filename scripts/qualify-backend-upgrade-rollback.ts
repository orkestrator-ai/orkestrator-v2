#!/usr/bin/env bun
/**
 * 0019 qualification: backend upgrade and rollback with real releases.
 *
 *   bun scripts/qualify-backend-upgrade-rollback.ts [options]
 *
 *   --old-ref <ref>       release that creates the starting state (default v2.21.0)
 *   --old-image <ref>     image that release runs (default its GHCR image)
 *   --floor-ref <ref>     release at the rollback floor (default v2.21.0, the
 *                         first tagged release that ships
 *                         container-lifecycle.schema.json)
 *   --main-ref <ref>      the current backend (default main)
 *   --main-image <ref>    image the current backend is configured with
 *                         (default the newest published GHCR image)
 *   --settle <seconds>    how long each backend runs idle before it is stopped
 *                         (default 60)
 *   --report <file>       write the evidence as JSON
 *   --keep                keep the temporary data directory, worktrees and
 *                         pulled images (for iterating on the harness)
 *
 * Each release runs from its own source, checked out with `git worktree add
 * --detach` into a temporary directory and installed with its own pinned Bun.
 * Every backend is headless (`apps/backend/src/main.ts`), agent-test flavoured
 * (no host credentials), bound to loopback with a private gateway token, over
 * one private temporary data directory and a temporary HOME; its Docker owner
 * label derives from that directory. Commands go through the backend's own
 * `/__orkestrator/invoke` endpoint.
 *
 * Old release: creates container environments (legacy-layer running,
 * volume-backed running, volume-backed stopped, one recorded but never
 * started) and stops.
 *
 * Floor blocked writer: with a marker requiring a newer writer than the floor
 * implements (no release writes one yet, so the marker is planted on the
 * floor's own store format and restored afterwards), the floor release reads
 * and must refuse every container mutation, leaving the directory and Docker
 * unchanged.
 *
 * Upgrade: current main runs over the old release's directory and only reads.
 * Environment and lifecycle records (field by field, apart from activity
 * observation), the marker, every owned container, volume and network, and
 * each running workspace's content must be unchanged. The store's SQLite
 * migration is reported as a migration, never as bookkeeping.
 *
 * Rollback: main creates its own environment and stops; the floor release
 * opens that directory and must not mutate it. Finally main's own blocked
 * writer runs the same mutation set.
 *
 * Never uses `orkestrator-v2:latest`, never prunes, never kills a process it
 * did not start. Owned Docker resources (owner label of the private data
 * directory) are removed on exit; an image this run pulled is removed again.
 * Exits 0 when every assertion held, 1 when one did not, 2 on setup errors.
 */
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dir, "..");
const OWNER_LABEL = "orkestrator-owner";
const GHCR = "ghcr.io/orkestrator-ai/orkestrator-v2";
const MARKER_FILE = "container-lifecycle.schema.json";

class SetupError extends Error {}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new SetupError(`${name} needs a value`);
  return value;
}

const config = {
  oldRef: option("--old-ref", "v2.21.0"),
  oldImage: option("--old-image", `${GHCR}:2.21.0`),
  floorRef: option("--floor-ref", "v2.21.0"),
  mainRef: option("--main-ref", "main"),
  mainImage: option("--main-image", `${GHCR}:2.26.3-beta`),
  settleSeconds: Number(option("--settle", "60")),
  report: option("--report", ""),
  keep: process.argv.includes("--keep"),
};

// ---------------------------------------------------------------------------
// Output and assertions
// ---------------------------------------------------------------------------

type Check = { phase: string; name: string; pass: boolean; detail: string };
const checks: Check[] = [];
const evidence: Record<string, unknown> = { config, startedAt: new Date().toISOString() };
let phase = "setup";
const section = (name: string) => (evidence[name] ??= {}) as Record<string, unknown>;

function log(message: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function check(name: string, pass: boolean, detail = ""): void {
  checks.push({ phase, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${phase}: ${name}${detail ? ` (${detail})` : ""}`);
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    throw new SetupError(
      `${command} ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || result.stdout).trim().slice(-600)}`,
    );
  }
  return { status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

// ---------------------------------------------------------------------------
// Private workspace, releases and images
// ---------------------------------------------------------------------------

const temp = mkdtempSync(path.join(os.tmpdir(), "q0019-upgrade-"));
const dataDir = path.join(temp, "data");
const homeDir = path.join(temp, "home");
// Agent-test backends mount a local bare remote into the container only from
// `<parent of the data directory>/fixtures/origin.git`.
const fixtureDir = path.join(temp, "fixtures");
const logDir = path.join(temp, "logs");
for (const dir of [dataDir, homeDir, fixtureDir, logDir, path.join(temp, "tmp")]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
writeFileSync(
  path.join(homeDir, ".gitconfig"),
  // Staged into each container as the user's Git configuration. Docker Desktop
  // can present the bind-mounted fixture remote as root-owned, which Git then
  // refuses as dubious ownership; trust exactly that fixture path.
  "[user]\n\tname = Orkestrator Qualification\n\temail = q0019@invalid.local\n" +
    "[safe]\n\tdirectory = /orkestrator-agent-test-origin.git\n",
);

type Release = { ref: string; commit: string; version: string; dir: string; bun: string };
const worktrees: string[] = [];
const pulledImages: string[] = [];
// The backend's dockerOwnerNamespace(dataDir), identical in every release
// since owner labels exist; known before anything is created so cleanup never
// depends on a container having been inspected.
const ownerNamespace = createHash("sha256")
  .update(path.resolve(dataDir))
  .digest("hex")
  .slice(0, 16);
const dockerHost = run("docker", [
  "context",
  "inspect",
  "--format",
  "{{.Endpoints.docker.Host}}",
]).stdout.trim();

function prepareRelease(ref: string): Release {
  const commit = run("git", ["-C", ROOT, "rev-parse", `${ref}^{commit}`]).stdout.trim();
  const existing = worktrees.find((dir) => dir.endsWith(commit.slice(0, 12)));
  const dir = existing ?? path.join(temp, `release-${commit.slice(0, 12)}`);
  if (!existing) {
    run("git", ["-C", ROOT, "worktree", "add", "--detach", dir, commit]);
    worktrees.push(dir);
  }
  const bunVersion = /^bun\s*=\s*"([^"]+)"/m.exec(
    readFileSync(path.join(dir, "mise.toml"), "utf8"),
  )?.[1];
  if (!bunVersion) throw new SetupError(`${ref} pins no Bun version in mise.toml`);
  run("mise", ["install", `bun@${bunVersion}`]);
  const bun = path.join(run("mise", ["where", `bun@${bunVersion}`]).stdout.trim(), "bin", "bun");
  if (!existing) {
    log(`installing ${ref} (${commit.slice(0, 9)}) with Bun ${bunVersion}`);
    run(bun, ["install", "--frozen-lockfile"], { cwd: dir, env: cleanEnv(process.env.HOME!) });
  }
  const version = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
    .version as string;
  return { ref, commit, version, dir, bun };
}

/** Pull by tag and return the immutable repository digest the backend is configured with. */
function resolveImage(reference: string): string {
  if (reference === "orkestrator-v2:latest" || reference.endsWith("orkestrator-v2:latest")) {
    throw new SetupError("orkestrator-v2:latest is never a qualification image");
  }
  const present =
    run("docker", ["image", "inspect", reference], { allowFailure: true }).status === 0;
  if (!present) {
    log(`pulling ${reference}`);
    run("docker", ["pull", "-q", reference]);
    pulledImages.push(reference);
  }
  const digests = JSON.parse(
    run("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", reference]).stdout,
  ) as string[];
  const repository = reference.replace(/[:@][^/]*$/, "");
  const pinned = digests.find((entry) => entry.startsWith(`${repository}@`));
  if (!pinned) throw new SetupError(`${reference} has no repository digest`);
  return pinned;
}

function cleanEnv(home: string): NodeJS.ProcessEnv {
  // Nothing from the calling Orkestrator (ORKESTRATOR_VERSION would override
  // the release's own version, ORKESTRATOR_PARENT_PID would tie the backend
  // to the caller) and no credentials reach the backend.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    SHELL: process.env.SHELL ?? "/bin/zsh",
    TMPDIR: path.join(temp, "tmp"),
    DOCKER_HOST: dockerHost,
    NO_COLOR: "1",
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

// ---------------------------------------------------------------------------
// Backend process and commands
// ---------------------------------------------------------------------------

type Backend = {
  label: string;
  release: Release;
  url: string;
  token: string;
  proc: ReturnType<typeof Bun.spawn>;
};
/** Processes this run started and has not stopped yet; only these are ever signalled. */
const liveProcesses = new Set<ReturnType<typeof Bun.spawn>>();

async function startBackend(
  label: string,
  release: Release,
  image: string,
  extraEnv: Record<string, string> = {},
): Promise<Backend> {
  const token = randomUUID();
  const outFile = path.join(logDir, `${label}.out.log`);
  const errFile = path.join(logDir, `${label}.err.log`);
  const proc = Bun.spawn(
    [
      release.bun,
      "apps/backend/src/main.ts",
      "--data-dir",
      dataDir,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--allow-non-tailscale-bind",
      "--runtime-flavor",
      "agent-test",
      "--strict-docker-owner",
      "--docker-image",
      image,
    ],
    {
      cwd: release.dir,
      env: {
        ...cleanEnv(homeDir),
        ORKESTRATOR_GATEWAY_TOKEN: token,
        ORKESTRATOR_CONTROL_MCP_PORT: "0",
        ...extraEnv,
      },
      stdout: Bun.file(outFile),
      stderr: Bun.file(errFile),
    },
  );
  liveProcesses.add(proc);
  void proc.exited.then(() => liveProcesses.delete(proc));
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const out = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
    const line = out.split("\n").find((entry) => entry.includes('"orkestrator-backend-ready"'));
    if (line) {
      const ready = JSON.parse(line) as { url: string };
      const version = /Starting Orkestrator (\S+)/.exec(out)?.[1] ?? "unknown";
      log(`${label}: ${release.ref} (${release.commit.slice(0, 9)}, reports ${version}) ready`);
      return { label, release, url: ready.url, token, proc };
    }
    if (proc.exitCode !== null) break;
    await Bun.sleep(500);
  }
  proc.kill("SIGKILL");
  await proc.exited;
  const errors = (existsSync(errFile) ? readFileSync(errFile, "utf8") : "")
    .split("\n")
    .filter((entry) => /^\w*Error\b|Error:/.test(entry));
  throw new BackendStartError(
    label,
    proc.exitCode,
    errors.at(-1)?.trim() ?? `no error line; see ${errFile}`,
  );
}

class BackendStartError extends SetupError {
  constructor(
    readonly label: string,
    readonly exitCode: number | null,
    readonly reason: string,
  ) {
    super(`${label} did not become ready (exit ${exitCode}): ${reason}`);
  }
}

async function stopBackend(backend: Backend): Promise<void> {
  backend.proc.kill("SIGTERM");
  const exited = await Promise.race([
    backend.proc.exited.then(() => true),
    Bun.sleep(90_000).then(() => false),
  ]);
  if (!exited) {
    backend.proc.kill("SIGKILL");
    await backend.proc.exited;
  }
  log(`${backend.label}: stopped (exit ${backend.proc.exitCode}${exited ? "" : ", forced"})`);
}

type InvokeResult = { ok: true; result: unknown } | { ok: false; error: string };

async function invoke(
  backend: Backend,
  command: string,
  args: Record<string, unknown> = {},
  timeoutMs = 600_000,
): Promise<InvokeResult> {
  const response = await fetch(new URL("/__orkestrator/invoke", backend.url), {
    method: "POST",
    headers: { authorization: `Bearer ${backend.token}`, "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await response.json().catch(() => ({}))) as { result?: unknown; error?: string };
  if (response.ok && payload.error === undefined) return { ok: true, result: payload.result };
  return { ok: false, error: payload.error ?? `HTTP ${response.status}` };
}

async function must<T>(
  backend: Backend,
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const answer = await invoke(backend, command, args);
  if (!answer.ok) throw new SetupError(`${backend.label} ${command}: ${answer.error}`);
  return answer.result as T;
}

type EnvironmentRecord = {
  id: string;
  name: string;
  containerId?: string | null;
  status?: string;
  setupPhase?: string;
  containerLifecycle?: unknown;
};

async function waitForSettledLifecycle(backend: Backend, environmentId: string): Promise<void> {
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    const snapshot = await invoke(backend, "get_container_lifecycle_snapshot", { environmentId });
    const operation = snapshot.ok
      ? (snapshot.result as { operation?: unknown } | null)?.operation
      : undefined;
    if (snapshot.ok && !operation) return;
    await Bun.sleep(2_000);
  }
  throw new SetupError(`${environmentId}: lifecycle operation did not settle`);
}

async function createContainerEnvironment(
  backend: Backend,
  projectId: string,
  name: string,
): Promise<EnvironmentRecord> {
  const environment = await must<EnvironmentRecord>(backend, "create_environment", {
    projectId,
    name,
    networkAccessMode: "restricted",
    environmentType: "containerized",
  });
  log(`${backend.label}: starting ${name}`);
  await must(backend, "start_environment", { environmentId: environment.id });
  await waitForSettledLifecycle(backend, environment.id);
  // Stopping the backend before workspace setup finishes would leave an
  // interrupted setup that the next backend settles as failed.
  let current = await must<EnvironmentRecord>(backend, "get_environment", {
    environmentId: environment.id,
  });
  const deadline = Date.now() + 600_000;
  while (current.setupPhase !== "ready" && current.setupPhase !== "failed") {
    if (Date.now() > deadline) throw new SetupError(`${name}: setup did not finish`);
    await Bun.sleep(2_000);
    current = await must<EnvironmentRecord>(backend, "get_environment", {
      environmentId: environment.id,
    });
  }
  if (current.setupPhase !== "ready") throw new SetupError(`${name}: setup ${current.setupPhase}`);
  if (!current.containerId) throw new SetupError(`${name} has no container after start`);
  learnOwner(current.containerId);
  return current;
}

async function stopEnvironment(
  backend: Backend,
  environment: EnvironmentRecord,
): Promise<EnvironmentRecord> {
  await must(backend, "stop_environment", { environmentId: environment.id });
  await waitForSettledLifecycle(backend, environment.id);
  return must<EnvironmentRecord>(backend, "get_environment", { environmentId: environment.id });
}

function learnOwner(containerId: string): void {
  const labels = JSON.parse(
    run("docker", ["inspect", "--format", "{{json .Config.Labels}}", containerId]).stdout,
  ) as Record<string, string>;
  const owner = labels[OWNER_LABEL];
  if (owner !== ownerNamespace) {
    throw new SetupError(
      `container ${containerId.slice(0, 12)} is not labelled with this run's owner`,
    );
  }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

type Snapshot = {
  files: Record<string, string>;
  rows: Record<string, string>;
  lifecycle: Record<string, unknown>;
  environments: Record<string, Record<string, unknown>>;
  storeVersion: number;
  docker: Record<string, string>;
  dockerDetail: Record<string, unknown>;
  marker: string | null;
};

const SQLITE_FILES = new Set([
  "orkestrator.sqlite",
  "orkestrator.sqlite-wal",
  "orkestrator.sqlite-shm",
]);

function walk(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir).sort()) {
    const absolute = path.join(dir, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      out[`${relative}/`] = `dir ${(stat.mode & 0o777).toString(8)}`;
      Object.assign(out, walk(absolute, relative));
    } else if (stat.isSymbolicLink()) {
      out[relative] = `link ${readlinkSync(absolute)}`;
    } else if (!SQLITE_FILES.has(relative)) {
      out[relative] =
        `file ${(stat.mode & 0o777).toString(8)} ${stat.size} ${sha256(readFileSync(absolute))}`;
    }
  }
  return out;
}

/** Row-level view of the store database, read from a private copy. */
function readDatabase(): {
  rows: Record<string, string>;
  lifecycle: Record<string, unknown>;
  environments: Record<string, Record<string, unknown>>;
  storeVersion: number;
} {
  const copy = mkdtempSync(path.join(temp, "db-"));
  for (const file of SQLITE_FILES) {
    if (existsSync(path.join(dataDir, file)))
      copyFileSync(path.join(dataDir, file), path.join(copy, file));
  }
  const rows: Record<string, string> = {};
  const lifecycle: Record<string, unknown> = {};
  const environments: Record<string, Record<string, unknown>> = {};
  let storeVersion = 0;
  const database = new Database(path.join(copy, "orkestrator.sqlite"));
  try {
    for (const { name } of database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()) {
      for (const row of database
        .query<Record<string, unknown>, []>(`SELECT * FROM "${name}"`)
        .all()) {
        const key =
          name === "store_rows"
            ? `${row.store}/${row.collection}/${row.key}`
            : String(
                row.name ??
                  row.key ??
                  row.id ??
                  row.selection_key ??
                  row.sequence ??
                  sha256(JSON.stringify(row)).slice(0, 16),
              );
        rows[`${name}:${key}`] = sha256(JSON.stringify(row));
        if (name === "store_rows" && row.store === "environments") {
          const value = JSON.parse(String(row.value)) as EnvironmentRecord & {
            containerLifecycle?: {
              schemaVersion?: number;
              revision?: number;
              runtime?: { containerId?: string; runtimeGeneration?: number } | null;
              storage?: { format?: string; workspaceGeneration?: number };
              operation?: unknown;
            };
          };
          const record = value.containerLifecycle;
          environments[value.name] = withoutActivityObservation(value);
          lifecycle[value.name] = {
            containerId: value.containerId?.slice(0, 12) ?? null,
            schemaVersion: record?.schemaVersion ?? null,
            revision: record?.revision ?? null,
            runtimeGeneration: record?.runtime?.runtimeGeneration ?? null,
            storage: record?.storage?.format ?? null,
            workspaceGeneration: record?.storage?.workspaceGeneration ?? null,
            operation: record?.operation ? "unresolved" : null,
          };
        }
      }
    }
    storeVersion =
      database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    rows["sqlite:user_version"] = String(storeVersion);
    rows["sqlite:schema"] = sha256(
      database
        .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master ORDER BY name")
        .all()
        .map((entry) => entry.sql ?? "")
        .join("\n"),
    );
  } finally {
    database.close();
    rmSync(copy, { recursive: true, force: true });
  }
  return { rows, lifecycle, environments, storeVersion };
}

/**
 * An environment record without the agent-activity observation a backend
 * refreshes whenever it samples a running container (`observedAt`,
 * `updatedAt`, `stale` per source and `agentActivityUpdatedAt`). Everything
 * else, including the lifecycle record, must survive an upgrade unchanged.
 */
function withoutActivityObservation(value: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(value);
  delete copy.agentActivityUpdatedAt;
  const sources = copy.agentActivitySources as Record<string, Record<string, unknown>> | undefined;
  for (const source of Object.values(sources ?? {})) {
    delete source.observedAt;
    delete source.updatedAt;
    delete source.stale;
  }
  return copy;
}

function snapshotDocker(): { docker: Record<string, string>; detail: Record<string, unknown> } {
  const docker: Record<string, string> = {};
  const detail: Record<string, unknown> = {};
  const filter = `label=${OWNER_LABEL}=${ownerNamespace}`;
  const ids = (args: string[]) =>
    run("docker", args)
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  for (const id of ids(["ps", "-a", "--no-trunc", "--filter", filter, "--format", "{{.ID}}"])) {
    const [c] = JSON.parse(run("docker", ["inspect", id]).stdout) as [Record<string, any>];
    const projection = {
      id: c.Id,
      name: c.Name,
      created: c.Created,
      image: c.Image,
      configImage: c.Config?.Image,
      labels: c.Config?.Labels,
      status: c.State?.Status,
      startedAt: c.State?.StartedAt,
      restartCount: c.RestartCount,
      hostConfig: sha256(JSON.stringify(c.HostConfig)),
      mounts: (c.Mounts as Array<Record<string, unknown>> | undefined)?.map(
        (m) => `${m.Type}:${m.Name ?? m.Source}->${m.Destination}:${m.RW ? "rw" : "ro"}`,
      ),
      networks: Object.keys(c.NetworkSettings?.Networks ?? {}).sort(),
    };
    docker[`container:${c.Name}`] = sha256(JSON.stringify(projection));
    if (c.State?.Status === "running") {
      // Content of the whole workspace, Git database included: a backend that
      // only reads must not refresh an index or rewrite a file in it.
      const digest = run(
        "docker",
        [
          "exec",
          c.Id,
          "sh",
          "-c",
          "cd /workspace && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum",
        ],
        { allowFailure: true },
      );
      docker[`workspace:${c.Name}`] =
        digest.status === 0 ? digest.stdout.trim() : `unreadable ${digest.status}`;
      // The applied network policy: /etc/orkestrator (allowed domains, mode,
      // policy, ports) and the packet rules without counters. Allowlist set
      // members are left out: the container's own DNS refresh changes them
      // with no backend running at all.
      const firewall = run(
        "docker",
        [
          "exec",
          "--user",
          "root",
          c.Id,
          "sh",
          "-c",
          "{ cd /etc/orkestrator && find . -maxdepth 1 -type f ! -name '.*' | LC_ALL=C sort | xargs cat; iptables-save; ip6tables-save; } 2>/dev/null | grep -v '^#' | sed 's/\\[[0-9]*:[0-9]*\\]//g' | sha256sum",
        ],
        { allowFailure: true },
      );
      docker[`network-policy:${c.Name}`] =
        firewall.status === 0 ? firewall.stdout.trim() : `unreadable ${firewall.status}`;
    }
    detail[`container:${c.Name}`] = {
      id: String(c.Id).slice(0, 12),
      created: c.Created,
      status: c.State?.Status,
      startedAt: c.State?.StartedAt,
      generation: c.Config?.Labels?.["orkestrator-runtime-generation"] ?? null,
      image: String(c.Image).slice(0, 19),
    };
  }
  for (const name of ids(["volume", "ls", "--filter", filter, "--format", "{{.Name}}"])) {
    const [v] = JSON.parse(run("docker", ["volume", "inspect", name]).stdout) as [
      Record<string, any>,
    ];
    docker[`volume:${name}`] = sha256(
      JSON.stringify({ name: v.Name, created: v.CreatedAt, labels: v.Labels, options: v.Options }),
    );
    detail[`volume:${name}`] = { created: v.CreatedAt };
  }
  for (const id of ids([
    "network",
    "ls",
    "--no-trunc",
    "--filter",
    filter,
    "--format",
    "{{.ID}}",
  ])) {
    const [n] = JSON.parse(run("docker", ["network", "inspect", id]).stdout) as [
      Record<string, any>,
    ];
    docker[`network:${n.Name}`] = sha256(
      JSON.stringify({
        id: n.Id,
        created: n.Created,
        labels: n.Labels,
        containers: Object.keys(n.Containers ?? {}).sort(),
      }),
    );
    detail[`network:${n.Name}`] = { id: String(n.Id).slice(0, 12), created: n.Created };
  }
  return { docker, detail };
}

function snapshot(label: string): Snapshot {
  const { rows, lifecycle, environments, storeVersion } = readDatabase();
  const { docker, detail } = snapshotDocker();
  const markerPath = path.join(dataDir, MARKER_FILE);
  const result: Snapshot = {
    files: walk(dataDir),
    rows,
    lifecycle,
    environments,
    storeVersion,
    docker,
    dockerDetail: detail,
    marker: existsSync(markerPath) ? readFileSync(markerPath, "utf8") : null,
  };
  section("snapshots")[label] = {
    files: Object.keys(result.files).length,
    rows: Object.keys(result.rows).length,
    storeVersion,
    lifecycle,
    docker: detail,
    marker: result.marker ? JSON.parse(result.marker) : null,
  };
  return result;
}

type Diff = { added: string[]; removed: string[]; changed: string[] };
function diff(before: Record<string, string>, after: Record<string, string>): Diff {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const result: Diff = { added: [], removed: [], changed: [] };
  for (const key of [...keys].sort()) {
    if (!(key in before)) result.added.push(key);
    else if (!(key in after)) result.removed.push(key);
    else if (before[key] !== after[key]) result.changed.push(key);
  }
  return result;
}

/**
 * Bookkeeping a backend writes on every run, never a migration of
 * environments or containers. Each entry carries the reason it is allowed.
 */
/** `changes` limits a rule to `+` added, `-` removed or `~` changed entries. */
type Expected = { pattern: RegExp; reason: string; changes?: string };
const EXPECTED_FILE_CHANGES: Expected[] = [
  { pattern: /^control-mcp\.json$/, reason: "this process's control MCP endpoint descriptor" },
  { pattern: /^logs\//, reason: "standalone backend logs (installStandaloneBackendLogging)" },
  {
    pattern: /^backups\/hourly-[^/]+\.sqlite$/,
    reason: "the store's periodic SQLite backup (storage-backups)",
  },
  { pattern: /^backups\/$/, reason: "backup directory" },
  {
    pattern: /^design-canvases\/index\.json$/,
    reason: "design-canvas index rewritten by the startup orphan sweep",
  },
];
const EXPECTED_ROW_CHANGES: Expected[] = [
  {
    pattern: /^store_rows:environments\/\/|^stores:environments$/,
    reason:
      "agent-activity observation of a running container; the field-level environment check is the assertion",
    changes: "~",
  },
  { pattern: /^leases:/, reason: "store lease heartbeats (single-writer lease)" },
  {
    pattern: /^stores:workflow-result-tools$/,
    reason: "per-process workflow result tool port and secret",
  },
];

/**
 * Opening an older store migrates its SQLite schema in place, after a
 * `pre-migration-v<from>` snapshot (docs/architecture/storage.md,
 * "Migrations"). Reported as a migration, never folded into bookkeeping.
 */
const STORE_MIGRATION_CHANGES: Expected[] = [
  {
    pattern: /^backups\/pre-migration-v\d+-[^/]+\.sqlite$/,
    reason: "snapshot taken before the store migration",
  },
  { pattern: /^sqlite:(schema|user_version)$/, reason: "store schema version raised" },
  {
    pattern: /^(change_[a-z_]+|sqlite_sequence):/,
    reason: "change-tracking ledger tables the version-4 migration adds, filled by its sampler",
  },
  { pattern: /^stores:host-maintenance$/, reason: "host-maintenance store of the newer backend" },
];

function classify(changes: string[], expected: Expected[]) {
  const explained: string[] = [];
  const unexplained: string[] = [];
  for (const change of changes) {
    const rule = expected.find(
      (entry) =>
        (!entry.changes || entry.changes.includes(change[0]!)) &&
        entry.pattern.test(change.replace(/^[+~-] /, "")),
    );
    if (rule) explained.push(`${change} — ${rule.reason}`);
    else unexplained.push(change);
  }
  return { explained, unexplained };
}

function compare(
  label: string,
  before: Snapshot,
  after: Snapshot,
  options: { allowStoreMigration: boolean },
) {
  const files = diff(before.files, after.files);
  const rows = diff(before.rows, after.rows);
  const docker = diff(before.docker, after.docker);
  const fileChanges = [
    ...files.added.map((key) => `+ ${key}`),
    ...files.removed.map((key) => `- ${key}`),
    ...files.changed.map((key) => `~ ${key}`),
  ];
  const rowChanges = [
    ...rows.added.map((key) => `+ ${key}`),
    ...rows.removed.map((key) => `- ${key}`),
    ...rows.changed.map((key) => `~ ${key}`),
  ];
  const migration = classify(
    [...fileChanges, ...rowChanges],
    options.allowStoreMigration ? STORE_MIGRATION_CHANGES : [],
  );
  const remaining = new Set(migration.unexplained);
  const fileClass = classify(
    fileChanges.filter((change) => remaining.has(change)),
    EXPECTED_FILE_CHANGES,
  );
  const rowClass = classify(
    rowChanges.filter((change) => remaining.has(change)),
    EXPECTED_ROW_CHANGES,
  );
  const environmentChanges: Record<string, string[]> = {};
  for (const name of new Set([
    ...Object.keys(before.environments),
    ...Object.keys(after.environments),
  ])) {
    const was = before.environments[name] ?? {};
    const now = after.environments[name] ?? {};
    const fields = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(
      (field) => JSON.stringify(was[field]) !== JSON.stringify(now[field]),
    );
    if (fields.length) environmentChanges[name] = fields;
  }
  section("diffs")[label] = {
    storeVersion: `${before.storeVersion} -> ${after.storeVersion}`,
    storeMigration: migration.explained,
    files: fileClass,
    rows: rowClass,
    environmentFields: environmentChanges,
    docker,
    lifecycleBefore: before.lifecycle,
    lifecycleAfter: after.lifecycle,
  };
  if (before.storeVersion !== after.storeVersion) {
    log(`  MIGRATED  store schema ${before.storeVersion} -> ${after.storeVersion}`);
  }
  for (const line of migration.explained) log(`  migration ${line}`);
  for (const line of [...fileClass.explained, ...rowClass.explained]) log(`  expected  ${line}`);
  for (const line of [...fileClass.unexplained, ...rowClass.unexplained])
    log(`  CHANGED   ${line}`);
  check(
    `${label}: environment records unchanged apart from activity observation`,
    Object.keys(environmentChanges).length === 0,
    JSON.stringify(environmentChanges),
  );
  if (!options.allowStoreMigration) {
    check(
      `${label}: store schema unchanged`,
      before.storeVersion === after.storeVersion,
      `${before.storeVersion} -> ${after.storeVersion}`,
    );
  }
  check(
    `${label}: lifecycle records unchanged`,
    JSON.stringify(before.lifecycle) === JSON.stringify(after.lifecycle),
    JSON.stringify(after.lifecycle),
  );
  check(
    `${label}: owned containers, volumes, networks and running workspaces unchanged`,
    docker.added.length + docker.removed.length + docker.changed.length === 0,
    [
      ...docker.added.map((k) => `+${k}`),
      ...docker.removed.map((k) => `-${k}`),
      ...docker.changed.map((k) => `~${k}`),
    ].join(", "),
  );
  check(`${label}: schema marker unchanged`, before.marker === after.marker);
  check(
    `${label}: no unexplained data-directory change`,
    fileClass.unexplained.length + rowClass.unexplained.length === 0,
    `${fileClass.unexplained.length} file(s), ${rowClass.unexplained.length} row(s)`,
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function prepareFixtureRepository(): { origin: string; clone: string } {
  const origin = path.join(fixtureDir, "origin.git");
  const clone = path.join(fixtureDir, "test-project");
  const env = cleanEnv(homeDir);
  run("git", ["init", "--bare", "-b", "main", origin], { env });
  run("git", ["init", "-b", "main", clone], { env });
  writeFileSync(path.join(clone, "README.md"), "# q0019 upgrade fixture\n");
  run("git", ["-C", clone, "add", "."], { env });
  run("git", ["-C", clone, "commit", "-m", "fixture"], { env });
  run("git", ["-C", clone, "remote", "add", "origin", origin], { env });
  run("git", ["-C", clone, "push", "-u", "origin", "main"], { env });
  return { origin, clone };
}

type Fixture = {
  projectId: string;
  legacy: EnvironmentRecord;
  running: EnvironmentRecord;
  stopped: EnvironmentRecord;
  current?: EnvironmentRecord;
  /** Disposable environments the old release made for each blocked-writer run. */
  victims: Record<string, Victims>;
};

type Victims = { stopped: EnvironmentRecord; unprovisioned: EnvironmentRecord };

async function readEverything(backend: Backend, fixture: Fixture) {
  const environments = await invoke(backend, "get_environments", { projectId: fixture.projectId });
  check(
    `${backend.label}: lists environments`,
    environments.ok,
    environments.ok ? "" : environments.error,
  );
  const snapshots: Record<string, unknown> = {};
  for (const environment of [fixture.legacy, fixture.running, fixture.stopped, fixture.current]) {
    if (!environment) continue;
    const answer = await invoke(backend, "get_container_lifecycle_snapshot", {
      environmentId: environment.id,
    });
    check(
      `${backend.label}: reads lifecycle snapshot of ${environment.name}`,
      answer.ok,
      answer.ok ? "" : answer.error,
    );
    snapshots[environment.name] = answer.ok ? answer.result : answer.error;
  }
  const image = await invoke(backend, "get_docker_image_status");
  section("reads")[backend.label] = {
    environments: environments.ok
      ? (environments.result as EnvironmentRecord[]).map((entry) => ({
          name: entry.name,
          status: entry.status,
        }))
      : environments.error,
    lifecycle: snapshots,
    image: image.ok ? image.result : image.error,
  };
  return snapshots;
}

/**
 * Every mutation a client can request. `gate` marks the ones whose
 * preconditions hold, so only the writer check can refuse them; the others
 * (an assigned container's raw removal, reattaching an attached container,
 * the retired prune) are refused regardless of the store format. Disposable
 * victims take the start, provision, raw and delete attempts so an accepted
 * one cannot damage the shared fixture.
 */
async function attemptMutations(
  backend: Backend,
  fixture: Fixture,
  victims: Victims,
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  const containerOf = (environment: EnvironmentRecord) => environment.containerId ?? "missing";
  const limits = { cpus: 1, memoryMiB: 1024, pids: 512 };
  type Attempt = [label: string, command: string, args: Record<string, unknown>, gate: boolean];
  const attempts: Attempt[] = [
    [
      "start a never-started environment",
      "start_environment",
      { environmentId: victims.unprovisioned.id },
      true,
    ],
    [
      "provision a never-started environment",
      "provision_environment",
      { environmentId: victims.unprovisioned.id },
      true,
    ],
    ["start (stopped)", "start_environment", { environmentId: victims.stopped.id }, true],
    [
      "start in background (stopped)",
      "start_environment_background",
      { environmentId: victims.stopped.id },
      true,
    ],
    ["stop (running)", "stop_environment", { environmentId: fixture.running.id }, true],
    ["stop (legacy)", "stop_environment", { environmentId: fixture.legacy.id }, true],
    [
      "rebuild preserving (volume)",
      "recreate_environment",
      {
        environmentId: fixture.running.id,
        intent: "preserve",
        expectedContainerId: containerOf(fixture.running),
      },
      true,
    ],
    [
      "migrate preserving (legacy)",
      "recreate_environment",
      {
        environmentId: fixture.legacy.id,
        intent: "preserve",
        expectedContainerId: containerOf(fixture.legacy),
      },
      true,
    ],
    [
      "recreate discarding",
      "recreate_environment",
      {
        environmentId: fixture.running.id,
        intent: "discard",
        expectedContainerId: containerOf(fixture.running),
      },
      true,
    ],
    [
      "port edit",
      "update_port_mappings",
      {
        environmentId: fixture.running.id,
        portMappings: [{ containerPort: 3000, hostPort: 0, protocol: "tcp", hostPortMode: "auto" }],
      },
      true,
    ],
    [
      "resource update applied now",
      "update_environment_resources",
      { environmentId: fixture.running.id, limits, applyNow: true },
      true,
    ],
    ["global resource limits", "set_container_resource_limits", { limits }, true],
    [
      "allowlist replace (running)",
      "update_environment_allowed_domains",
      // Domains of its own per run, so each run leaves a different list behind.
      {
        environmentId: fixture.running.id,
        domains: [`${backend.label}.example.com`, `${backend.label}-kept.example.com`],
      },
      true,
    ],
    [
      "allowlist remove (running)",
      "remove_environment_domains",
      { environmentId: fixture.running.id, domains: [`${backend.label}.example.com`] },
      true,
    ],
    [
      "raw start (stopped)",
      "docker_start_container",
      { containerId: containerOf(victims.stopped) },
      true,
    ],
    [
      "raw stop (running)",
      "docker_stop_container",
      { containerId: containerOf(fixture.running) },
      true,
    ],
    [
      "raw remove (assigned)",
      "docker_remove_container",
      { containerId: containerOf(victims.stopped) },
      false,
    ],
    [
      "reattach (already attached)",
      "reattach_container",
      {
        projectId: fixture.projectId,
        containerId: containerOf(victims.stopped),
        name: "q0019-reattach",
      },
      false,
    ],
    [
      "resolve operation",
      "resolve_container_operation",
      {
        environmentId: fixture.running.id,
        operationId: "0192d4f0-0000-7000-8000-000000000000",
        resolution: "release",
      },
      true,
    ],
    ["prune (retired)", "docker_system_prune", {}, false],
  ];
  const preview = await invoke(backend, "docker_cleanup_preview");
  const rows = preview.ok
    ? ((preview.result as { rows?: Array<{ kind: string; id: string }> }).rows ?? [])
    : [];
  attempts.push([
    `reviewed cleanup of every previewed resource (${rows.length})`,
    "docker_cleanup_execute",
    {
      selectionToken: preview.ok
        ? ((preview.result as { selectionToken?: string }).selectionToken ?? "missing")
        : "missing",
      containerIds: rows.filter((row) => row.kind === "container").map((row) => row.id),
      volumeNames: rows.filter((row) => row.kind === "volume").map((row) => row.id),
      networkNames: rows.filter((row) => row.kind === "network").map((row) => row.id),
    },
    true,
  ]);
  attempts.push([
    "delete (stopped)",
    "delete_environment",
    { environmentId: victims.stopped.id },
    true,
  ]);
  attempts.push([
    "delete (never started)",
    "delete_environment",
    { environmentId: victims.unprovisioned.id },
    true,
  ]);
  for (const [label, command, args, gate] of attempts) {
    const answer = await invoke(backend, command, args, 180_000).catch(
      (error: unknown): InvokeResult => ({ ok: false, error: String(error) }),
    );
    const refusal = answer.ok ? null : answer.error;
    const byFormat = refusal !== null && /unsupported-format|newer Orkestrator/.test(refusal);
    let effect: string | undefined;
    if (answer.ok && command === "start_environment_background") {
      // Accepted means acknowledged; the start itself runs afterwards.
      await Bun.sleep(15_000);
      effect = `container ${run("docker", ["inspect", "--format", "{{.State.Status}}", containerOf(victims.stopped)], { allowFailure: true }).stdout.trim() || "missing"} 15 s later`;
    }
    if (answer.ok && command === "docker_cleanup_execute") {
      const outcomes =
        (answer.result as { outcomes?: Array<{ outcome: string }> } | null)?.outcomes ?? [];
      const tally: Record<string, number> = {};
      for (const entry of outcomes) tally[entry.outcome] = (tally[entry.outcome] ?? 0) + 1;
      effect = `outcomes ${JSON.stringify(tally)}`;
    }
    results.push({
      effect,
      command: `${command} — ${label}`,
      gate,
      accepted: answer.ok,
      byFormat,
      answer:
        refusal?.slice(0, 240) ??
        `accepted: ${JSON.stringify(answer.ok ? answer.result : null)?.slice(0, 200)}`,
    });
    log(
      `  ${answer.ok ? "ACCEPTED" : byFormat ? "refused (format)" : "refused (other)"}  ${command} — ${label}${refusal && !byFormat ? `: ${refusal.slice(0, 160)}` : ""}`,
    );
  }
  return results;
}

async function main(): Promise<number> {
  log(
    `private directory ${temp}; Docker ${dockerHost}; load ${os
      .loadavg()
      .map((n) => n.toFixed(1))
      .join(" ")}`,
  );
  const oldRelease = prepareRelease(config.oldRef);
  const floorRelease =
    config.floorRef === config.oldRef ? oldRelease : prepareRelease(config.floorRef);
  const mainRelease = prepareRelease(config.mainRef);
  const oldImage = resolveImage(config.oldImage);
  const mainImage = resolveImage(config.mainImage);
  const floorWriter = Number(
    /REGISTRY_WRITER_VERSION = (\d+)/.exec(
      readFileSync(
        path.join(floorRelease.dir, "apps/backend/src/core/registry-writer-lease.ts"),
        "utf8",
      ),
    )?.[1] ?? Number.NaN,
  );
  evidence.releases = Object.fromEntries(
    [oldRelease, floorRelease, mainRelease].map((release) => [
      release.ref,
      { commit: release.commit, version: release.version },
    ]),
  );
  evidence.images = { old: oldImage, main: mainImage };
  evidence.floorWriterVersion = floorWriter;
  log(
    `old ${oldRelease.ref}@${oldRelease.commit.slice(0, 9)} (${oldRelease.version}) on ${oldImage}`,
  );
  log(
    `floor ${floorRelease.ref}@${floorRelease.commit.slice(0, 9)} (${floorRelease.version}), writer ${floorWriter}`,
  );
  log(
    `main ${mainRelease.ref}@${mainRelease.commit.slice(0, 9)} (${mainRelease.version}) on ${mainImage}`,
  );
  const { origin, clone } = prepareFixtureRepository();
  const markerPath = path.join(dataDir, MARKER_FILE);
  const futureMarker = () =>
    `${JSON.stringify(
      {
        schemaVersion: floorWriter + 1,
        minimumWriterVersion: floorWriter + 1,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`;

  // --- State written by the old release ----------------------------------------
  phase = "old release";
  // Only releases up to 2.30.0-beta honour this switch (removed with todo 0021);
  // the default old release, v2.21.0, does. A newer --old-ref creates a
  // volume-backed environment here, which the legacy check below reports.
  let backend = await startBackend("old-legacy", oldRelease, oldImage, {
    ORKESTRATOR_CONTAINER_STORAGE: "legacy-layer",
  });
  const project = await must<{ id: string }>(backend, "add_project", {
    gitUrl: origin,
    localPath: clone,
  });
  const legacy = await createContainerEnvironment(backend, project.id, "q0019-legacy-running");
  await stopBackend(backend);
  backend = await startBackend("old", oldRelease, oldImage);
  const running = await createContainerEnvironment(backend, project.id, "q0019-volume-running");
  const stoppedCreated = await createContainerEnvironment(
    backend,
    project.id,
    "q0019-volume-stopped",
  );
  const stopped = await stopEnvironment(backend, stoppedCreated);
  const victims: Record<string, Victims> = {};
  for (const label of ["floor-blocked", "main-blocked"]) {
    victims[label] = {
      stopped: await stopEnvironment(
        backend,
        await createContainerEnvironment(backend, project.id, `q0019-victim-${label}-stopped`),
      ),
      unprovisioned: await must<EnvironmentRecord>(backend, "create_environment", {
        projectId: project.id,
        name: `q0019-victim-${label}-never-started`,
        networkAccessMode: "restricted",
        environmentType: "containerized",
      }),
    };
  }
  const fixture: Fixture = { projectId: project.id, legacy, running, stopped, victims };
  await readEverything(backend, fixture);
  await stopBackend(backend);
  const oldState = snapshot("after-old-release");
  log(`old release state (store v${oldState.storeVersion}): ${JSON.stringify(oldState.lifecycle)}`);

  // --- Floor mechanism on the floor's own store format ---------------------------
  // No released backend writes a marker the floor does not satisfy yet, so a
  // newer writer is represented by its marker alone, on a store the floor can
  // open. The original marker bytes are restored afterwards.
  phase = "floor blocked writer";
  const originalMarker = readFileSync(markerPath);
  writeFileSync(markerPath, futureMarker(), { mode: 0o600 });
  await blockedWriterRun("floor-blocked", floorRelease, oldImage, fixture);
  writeFileSync(markerPath, originalMarker, { mode: 0o600 });

  // --- Upgrade: current main over the old release's directory --------------------
  phase = "upgrade";
  const beforeUpgrade = snapshot("before-main-upgrade");
  backend = await startBackend("main-upgrade", mainRelease, mainImage);
  const upgradeReads = await readEverything(backend, fixture);
  const legacyView = JSON.stringify(upgradeReads[legacy.name] ?? "");
  check(
    "legacy environment reported as legacy-layer",
    /legacy-layer/.test(legacyView),
    legacyView.slice(0, 240),
  );
  log(`main idle for ${config.settleSeconds}s`);
  await Bun.sleep(config.settleSeconds * 1000);
  const whileRunning = snapshotDocker();
  check(
    "containers and workspaces unchanged while main runs",
    JSON.stringify(whileRunning.docker) === JSON.stringify(beforeUpgrade.docker),
    JSON.stringify(diff(beforeUpgrade.docker, whileRunning.docker)),
  );
  await stopBackend(backend);
  compare("upgrade", beforeUpgrade, snapshot("after-main-upgrade"), { allowStoreMigration: true });

  // --- Rollback: the floor opens a directory main has written ---------------------
  phase = "rollback";
  backend = await startBackend("main-writer", mainRelease, mainImage);
  fixture.current = await createContainerEnvironment(backend, project.id, "q0019-main-created");
  await stopBackend(backend);
  const mainWritten = snapshot("after-main-writes");
  const marker = mainWritten.marker
    ? (JSON.parse(mainWritten.marker) as { minimumWriterVersion: number })
    : null;
  evidence.markerAsWrittenByMain = marker;
  log(
    `main wrote store v${mainWritten.storeVersion}; its marker requires writer ${marker?.minimumWriterVersion}; the floor implements writer ${floorWriter}`,
  );
  try {
    backend = await startBackend("floor-over-main", floorRelease, oldImage);
    await readEverything(backend, fixture);
    const probe = await invoke(backend, "stop_environment", { environmentId: fixture.stopped.id });
    evidence.floorOverMain = {
      started: true,
      probe: probe.ok ? "stop_environment accepted" : probe.error.slice(0, 240),
    };
    log(
      `floor over main's directory started; stop probe ${probe.ok ? "accepted" : probe.error.slice(0, 160)}`,
    );
    await stopBackend(backend);
  } catch (error) {
    if (!(error instanceof BackendStartError)) throw error;
    evidence.floorOverMain = { started: false, exitCode: error.exitCode, reason: error.reason };
    log(`floor over main's directory refused to start (exit ${error.exitCode}): ${error.reason}`);
  }
  const floorStarted = (evidence.floorOverMain as { started: boolean }).started;
  check(
    "floor release does not mutate a directory main has written",
    !floorStarted,
    floorStarted ? "it started as a writer" : "refused to open the store",
  );
  compare("floor-over-main", mainWritten, snapshot("after-floor-over-main"), {
    allowStoreMigration: false,
  });

  // --- Main's own blocked writer, on its own store format --------------------------
  phase = "main blocked writer";
  writeFileSync(markerPath, futureMarker(), { mode: 0o600 });
  await blockedWriterRun("main-blocked", mainRelease, mainImage, fixture);
  return checks.every((entry) => entry.pass) ? 0 : 1;
}

/**
 * Opens the directory with a marker requiring a newer writer than `release`
 * implements, reads, attempts every container mutation, and checks nothing in
 * the directory or Docker changed.
 */
async function blockedWriterRun(
  label: string,
  release: Release,
  image: string,
  fixture: Fixture,
): Promise<void> {
  const before = snapshot(`before-${label}`);
  const backend = await startBackend(label, release, image);
  await readEverything(backend, fixture);
  const results = await attemptMutations(backend, fixture, fixture.victims[label]!);
  section("mutations")[label] = results;
  const accepted = results.filter((entry) => entry.accepted).map((entry) => entry.command);
  const notByFormat = results
    .filter((entry) => entry.gate && !entry.accepted && !entry.byFormat)
    .map((entry) => entry.command);
  check(`${label}: every mutation refused`, accepted.length === 0, accepted.join("; "));
  check(
    `${label}: every refusal whose preconditions held names the newer store format`,
    notByFormat.length === 0,
    notByFormat.join("; "),
  );
  await stopBackend(backend);
  compare(label, before, snapshot(`after-${label}`), { allowStoreMigration: false });
}

async function cleanup(): Promise<void> {
  // A killed backend's in-flight `docker create` can still land; let it, then sweep.
  for (const proc of liveProcesses) proc.kill("SIGKILL");
  await Bun.sleep(liveProcesses.size ? 5_000 : 0);
  {
    const filter = `label=${OWNER_LABEL}=${ownerNamespace}`;
    const list = (args: string[]) =>
      run("docker", args, { allowFailure: true })
        .stdout.split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const containers = list(["ps", "-a", "--no-trunc", "--filter", filter, "--format", "{{.ID}}"]);
    if (containers.length) run("docker", ["rm", "-f", "-v", ...containers], { allowFailure: true });
    const volumes = list(["volume", "ls", "--filter", filter, "--format", "{{.Name}}"]);
    if (volumes.length) run("docker", ["volume", "rm", ...volumes], { allowFailure: true });
    const networks = list(["network", "ls", "--filter", filter, "--format", "{{.ID}}"]);
    if (networks.length) run("docker", ["network", "rm", ...networks], { allowFailure: true });
    const left = [
      ...list(["ps", "-a", "--filter", filter, "--format", "{{.ID}}"]),
      ...list(["volume", "ls", "--filter", filter, "--format", "{{.Name}}"]),
      ...list(["network", "ls", "--filter", filter, "--format", "{{.ID}}"]),
    ];
    log(
      `removed ${containers.length} container(s), ${volumes.length} volume(s), ${networks.length} network(s) owned by this run; ${left.length} left`,
    );
    evidence.cleanup = {
      containers: containers.length,
      volumes: volumes.length,
      networks: networks.length,
      left: left.length,
    };
  }
  // --keep also keeps pulled images, so an iteration does not pull them again.
  if (!config.keep) {
    for (const image of pulledImages) run("docker", ["image", "rm", image], { allowFailure: true });
  }
  for (const dir of worktrees) {
    if (!config.keep)
      run("git", ["-C", ROOT, "worktree", "remove", "--force", dir], { allowFailure: true });
  }
  if (!config.keep) rmSync(temp, { recursive: true, force: true });
}

let exitCode = 2;
try {
  exitCode = await main();
} catch (error) {
  console.error(
    `${error instanceof SetupError ? "setup" : "error"}: ${error instanceof Error ? error.message : String(error)}`,
  );
  exitCode = error instanceof SetupError ? 2 : 1;
} finally {
  evidence.checks = checks;
  evidence.finishedAt = new Date().toISOString();
  evidence.exitCode = exitCode;
  await cleanup();
  if (config.report) writeFileSync(config.report, `${JSON.stringify(evidence, null, 2)}\n`);
}
const failed = checks.filter((entry) => !entry.pass).length;
console.log(
  `${checks.length - failed}/${checks.length} checks passed${config.keep ? `; kept ${temp}` : ""}`,
);
process.exit(exitCode);
