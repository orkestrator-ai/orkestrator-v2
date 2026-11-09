/**
 * A per-project bare Git mirror that new container environments clone from
 * (`docs/architecture/container-lifecycle.md#project-git-mirror`).
 *
 * It is a cache. Nothing depends on it existing: `workspace-setup.sh` checks it
 * and falls back to its ordinary clone, and every clone from it is
 * self-contained, so a mirror can be stale, rebuilt or removed at any moment.
 *
 * Layout, under `<data>/git-mirrors/<project id>/` (owner-only):
 * - `mount-<access kind>/` is a bind source, one per kind of access a container
 *   can hold (`project-git-mirror-access.ts`). Each is world-readable because
 *   the container's user is not the backend's user under rootless Docker, and
 *   exists for as long as the project once a container has been bound to it.
 * - `mount-<kind>/mirror.git` appears only by rename, once complete, fetched
 *   with exactly that kind's access. At most one kind holds a mirror: a refresh
 *   retires every other kind's, so a reader whose access no longer matches what
 *   containers are given finds none. `mount/` is the layout before access kinds;
 *   its mirror is retired the same way and the directory kept, because stopped
 *   containers still name it with `-v`.
 * - `state.json` and the `.building-*` and `.retired-*` scratch directories are
 *   beside the bind sources, so a container sees none of them.
 *
 * Every remote URL and credential is passed per transfer. No `remote` section
 * is ever written, so the mirror's config holds nothing to leak.
 *
 * A build can start from what the project's host checkout already holds, but a
 * checkout decides nothing: see `seedMirror`.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { withoutUrlCredentials } from "@orkestrator/protocol/git-remote-url";
import { allowlistEntryDomain, parseAllowlistEntry } from "@orkestrator/protocol/network-allowlist";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { CommandContext } from "./commands-context.js";
import type { Project } from "./models.js";
import {
  containerCloneUrl,
  GIT_MIRROR_ACCESS_KINDS,
  gitMirrorFetchPlan,
  makeFetchHome,
  readGitMirrorAccount,
  type GitMirrorAccess,
  type GitMirrorAccessKind,
} from "./project-git-mirror-access.js";
import { removeConfinedDirectory } from "./path-safety.js";
import { runCommand } from "./shell.js";

const log = createLogger("docker");

export const GIT_MIRRORS_DIR = "git-mirrors";
export const CONTAINER_GIT_MIRROR_MOUNT = "/orkestrator-git-mirror";
export const CONTAINER_GIT_MIRROR_PATH = `${CONTAINER_GIT_MIRROR_MOUNT}/mirror.git`;
export const GIT_MIRROR_NAME = "mirror.git";

/** Branches only: clones use `--no-tags`, and `refs/pull/*` can dwarf the repository. */
const MIRROR_REFSPEC = "+refs/heads/*:refs/heads/*";
/**
 * What a seed reads from a checkout. Remote-tracking refs are the ones likely to
 * be on the remote, so local work never leaves the checkout, and a wrong or forged
 * one costs nothing: the remote does not recognise it and the mirror never sees it.
 */
const SEED_REFSPEC = "+refs/remotes/*:refs/seed/*";
/** A clone only pays the remote for what the mirror lacks, so this need not be tight. */
export const GIT_MIRROR_REFRESH_INTERVAL_MS = 15 * 60_000;
/**
 * Each clone copies its history out of the mirror, so this bounds every
 * environment's Git directory as well as the mirror. A larger repository stays
 * on the blobless clone.
 */
export const GIT_MIRROR_MAX_BYTES = 2 * 1024 ** 3;
const GIT_MIRROR_MIN_FREE_BYTES = 1024 ** 3;
/**
 * A seed's worst case in limits: what the checkout hands over, what the remote
 * adds to it, and the mirror copied out of them. A plain build needs one.
 */
const GIT_MIRROR_SEED_LIMITS_FREE = 3;
/** A repository rarely shrinks, so an oversized one is only looked at again weekly. */
const GIT_MIRROR_OVERSIZED_RETRY_MS = 7 * 24 * 60 * 60_000;
/** Fetch failures in a row before the mirror is rebuilt rather than updated. */
const GIT_MIRROR_REBUILD_AFTER_FAILURES = 3;
const GIT_MIRROR_SIZE_CHECK_MS = 5_000;
const GIT_MIRROR_FETCH_TIMEOUT_MS = 30 * 60_000;
const GIT_MIRROR_LOCAL_TIMEOUT_MS = 10 * 60_000;
const GIT_MIRROR_COMPACT_ABOVE_PACKS = 30;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** `workspace-setup.sh` reports how a clone went on one line of its output. */
const CLONE_OUTCOME_PATTERN = new RegExp(
  `${String.fromCharCode(0x1e)}ORKESTRATOR_GIT_MIRROR:([a-z-]+)${String.fromCharCode(0x1f)}`,
);
const SUSPECT_OUTCOMES = new Set(["corrupt", "clone-failed", "not-self-contained"]);

type MirrorState = {
  /** Hash of the credential-free remote, so a changed project URL rebuilds. */
  remote?: string;
  /** The access kind the live mirror was fetched with; another kind rebuilds. */
  access?: GitMirrorAccessKind;
  /**
   * The GitHub login that kind's token acted as (not secret), lower-cased, or
   * null when it could not be read. A different login rebuilds.
   */
  account?: string | null;
  lastAttemptAt?: number;
  failures?: number;
  oversizedUntil?: number;
  /** A clone could not use the mirror: verify it before the next fetch. */
  suspect?: boolean;
  suspectRevision?: string;
};

export type GitMirrorRefreshOutcome =
  | "built"
  | "fetched"
  | "skipped-recent"
  | "skipped-oversized"
  | "skipped-low-disk"
  | "skipped-shutdown"
  | "oversized"
  | "empty"
  | "failed"
  | "cancelled";

export type GitMirrorRefreshOptions = {
  /** Ignore the refresh interval and a recent oversized verdict. */
  force?: boolean;
  now?: () => number;
  maxBytes?: number;
  freeBytes?: (directory: string) => Promise<number>;
  run?: typeof runCommand;
  /** Reads the account a token acts as; `gh api user` by default. */
  accountLogin?: (token: string) => Promise<string | undefined>;
};

type GitMirrorContext = Pick<CommandContext, "storage"> &
  Partial<Pick<CommandContext, "environmentLifecycleTasks">> & {
    runtime?: Pick<CommandContext["runtime"], "gitHubCli">;
  };

type MirrorProject = Pick<Project, "id" | "gitUrl"> & Partial<Pick<Project, "localPath">>;

type MirrorWriter = { controller: AbortController; done: Promise<GitMirrorRefreshOutcome> };

/**
 * One writer per mirror in this backend. A launch that arrives during a refresh
 * joins it. Another backend on the same data directory holds no writer lease,
 * so it creates no containers and starts no refresh.
 */
const writers = new Map<string, MirrorWriter>();

function projectDirectory(dataDir: string, projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("Invalid project id");
  return path.join(dataDir, GIT_MIRRORS_DIR, projectId);
}

/** Before access kinds, every container of a project was bound here. */
const LEGACY_MOUNT = "mount";

function mountName(kind: GitMirrorAccessKind): string {
  return `mount-${kind}`;
}

function mountDirectory(dataDir: string, projectId: string, kind: GitMirrorAccessKind): string {
  return path.join(projectDirectory(dataDir, projectId), mountName(kind));
}

function remoteFingerprint(gitUrl: string): string {
  return createHash("sha256").update(withoutUrlCredentials(gitUrl)).digest("hex");
}

async function readState(directory: string): Promise<MirrorState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as MirrorState) : {};
  } catch {
    return {};
  }
}

const stateWrites = new Map<string, Promise<void>>();

/** Serialize state publication with clone reports; a refresh may clear only the report it read. */
async function writeState(
  directory: string,
  state: MirrorState,
  clearRevision?: { revision: string | undefined },
  cloneReport = false,
): Promise<void> {
  const previous = stateWrites.get(directory) ?? Promise.resolve();
  const done = (async () => {
    await previous.catch(() => undefined);
    const current = await readState(directory);
    const next = cloneReport
      ? { ...current, suspect: true, suspectRevision: state.suspectRevision }
      : { ...state };
    if (!cloneReport && (!clearRevision || current.suspectRevision !== clearRevision.revision)) {
      next.suspect = current.suspect;
      next.suspectRevision = current.suspectRevision;
    }
    const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await rename(temporary, path.join(directory, "state.json"));
  })();
  stateWrites.set(directory, done);
  try {
    await done;
  } finally {
    if (stateWrites.get(directory) === done) stateWrites.delete(directory);
  }
}

/** A deleted project parent can be recreated by rootful Docker as root. */
function permissionRemediation(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EACCES" || code === "EPERM"
    ? "Restore backend-user ownership of git-mirrors/<project id> on the host; see docs/development/disk-usage.md#project-git-mirrors"
    : undefined;
}

async function ensureProjectDirectories(
  dataDir: string,
  projectId: string,
  kind: GitMirrorAccessKind,
): Promise<void> {
  const root = path.join(dataDir, GIT_MIRRORS_DIR);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(projectDirectory(dataDir, projectId), { recursive: true, mode: 0o700 });
  const mount = mountDirectory(dataDir, projectId, kind);
  await mkdir(mount, { recursive: true, mode: 0o755 });
  // Whatever the umask: the workload user must be able to read what is inside.
  await chmod(mount, 0o755).catch(async () => {
    // A rootful daemon recreates a removed source as root (see below). It is
    // empty, and this directory is ours, so it can be replaced.
    await rmdir(mount);
    await mkdir(mount, { mode: 0o755 });
    await chmod(mount, 0o755);
  });
}

/**
 * The read-only mount of `kind`'s mirror and its pointer for a new container, or
 * nothing when the mount cannot be set up, which only means the clone goes to
 * the remote. `kind` must be the access this container is given, from
 * `resolveGitMirrorAccess`: it can then read only what it could fetch itself.
 *
 * `-v`, not `--mount`: a stopped container's start must survive its source being
 * removed, and only `-v` has Docker recreate it instead of refusing to start.
 * Verified against Docker Engine 29.9.2.
 */
export async function gitMirrorContainerArguments(
  dataDir: string,
  project: Pick<Project, "id">,
  kind: GitMirrorAccessKind,
): Promise<string[]> {
  try {
    await ensureProjectDirectories(dataDir, project.id, kind);
    const mount = mountDirectory(dataDir, project.id, kind);
    // `-v` splits on colons, so such a path could fail the whole container create.
    if (mount.includes(":")) throw new Error("The data directory path contains a colon");
    return [
      "-v",
      `${mount}:${CONTAINER_GIT_MIRROR_MOUNT}:ro`,
      "-e",
      `ORKESTRATOR_GIT_MIRROR=${CONTAINER_GIT_MIRROR_PATH}`,
    ];
  } catch (error) {
    log.warn("git-mirror.mount-unavailable", {
      projectId: project.id,
      remediation: permissionRemediation(error),
      error: formatLogError(error, { message: false }),
    });
    return [];
  }
}

/**
 * The host and port a container's clone of `gitUrl` connects to. Follows
 * `convert_ssh_to_https` in `docker/workspace-setup.sh`, which turns an SSH
 * remote into HTTPS on the same host before cloning. Null for anything else.
 */
export function containerCloneEndpoint(gitUrl: string): { host: string; port: number } | null {
  const converted = containerCloneUrl(gitUrl);
  if (!converted) return null;
  try {
    const parsed = new URL(converted);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "http:" ? 80 : 443;
    return parsed.hostname ? { host: parsed.hostname.toLowerCase(), port } : null;
  } catch {
    return null;
  }
}

/**
 * Whether a restricted container could fetch `gitUrl` itself. The mirror holds
 * what the remote serves, so a container that cannot reach the remote must not
 * read it through the mount instead. GitHub's published ranges are always open
 * on TCP 443; any other host needs an allowlist entry for the clone's port
 * (`docker/firewall-domains.sh`), or for the host alone under a policy before 3,
 * which opens every port of an allowed address.
 */
export function restrictedContainerReachesGitRemote(
  gitUrl: string,
  allowedEntries: readonly string[],
  policyVersion: number,
): boolean {
  const endpoint = containerCloneEndpoint(gitUrl);
  if (!endpoint) return false;
  if (endpoint.host === "github.com" && endpoint.port === 443) return true;
  return allowedEntries.some((value) => {
    if (policyVersion < 3) return allowlistEntryDomain(value).toLowerCase() === endpoint.host;
    const entry = parseAllowlistEntry(value);
    return (
      entry !== null &&
      entry.protocol === "tcp" &&
      entry.domain.toLowerCase() === endpoint.host &&
      entry.port === endpoint.port
    );
  });
}

/** Starts a refresh in the background. Never rejects and never delays a launch. */
export function scheduleProjectGitMirrorRefresh(
  context: GitMirrorContext,
  project: MirrorProject,
  access: GitMirrorAccess,
): void {
  void refreshProjectGitMirror(context, project, access);
}

/**
 * Admission must be closed first. Wait for the entire writer, including local
 * Git, scratch cleanup and state publication, before giving up the registry lease.
 */
export async function stopProjectGitMirrorRefreshes(dataDir: string): Promise<void> {
  const prefix = path.join(dataDir, GIT_MIRRORS_DIR) + path.sep;
  const active = Array.from(writers.entries()).filter(([key]) => key.startsWith(prefix));
  for (const [, writer] of active) writer.controller.abort();
  await Promise.all(active.map(([, writer]) => writer.done));
}

/**
 * Creates or updates a project's mirror for `access`, the access containers are
 * given now, and retires every other kind's. Failures are logged, never thrown.
 */
export function refreshProjectGitMirror(
  context: GitMirrorContext,
  project: MirrorProject,
  access: GitMirrorAccess,
  options: GitMirrorRefreshOptions = {},
): Promise<GitMirrorRefreshOutcome> {
  if (context.environmentLifecycleTasks?.isAccepting() === false)
    return Promise.resolve("skipped-shutdown");
  const key = path.join(context.storage.getDataDir(), GIT_MIRRORS_DIR, project.id);
  const running = writers.get(key);
  if (running) return running.done;
  const controller = new AbortController();
  const done = runRefresh(context, project, access, options, controller)
    .catch((error: unknown) => {
      log.warn("git-mirror.refresh-failed", {
        remediation: permissionRemediation(error),
        projectId: project.id,
        error: formatLogError(error, { message: false }),
      });
      return "failed" as const;
    })
    .finally(() => writers.delete(key));
  writers.set(key, { controller, done });
  return done;
}

async function runRefresh(
  context: GitMirrorContext,
  project: MirrorProject,
  access: GitMirrorAccess,
  options: GitMirrorRefreshOptions,
  controller: AbortController,
): Promise<GitMirrorRefreshOutcome> {
  if (context.environmentLifecycleTasks?.isAccepting() === false) return "skipped-shutdown";
  const dataDir = context.storage.getDataDir();
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? GIT_MIRROR_MAX_BYTES;
  const execute = options.run ?? runCommand;
  const run: typeof runCommand = (command, args, settings) => {
    controller.signal.throwIfAborted();
    return execute(command, args, {
      ...settings,
      signal: settings?.signal
        ? AbortSignal.any([controller.signal, settings.signal])
        : controller.signal,
    });
  };
  const readAccount = (token: string): Promise<string | undefined> =>
    (
      options.accountLogin?.(token) ??
      readGitMirrorAccount({ ...access, token }, context.runtime?.gitHubCli, run)
    ).catch(() => undefined);
  const directory = projectDirectory(dataDir, project.id);
  await ensureProjectDirectories(dataDir, project.id, access.kind);
  const mirror = path.join(mountDirectory(dataDir, project.id, access.kind), GIT_MIRROR_NAME);
  const state = await readState(directory);
  // First, so no reader of another kind's mount, or of the legacy one, keeps a
  // mirror fetched with access containers are no longer given.
  const retiredKinds = await retireOtherAccessMirrors(directory, access.kind);
  // A token can change account under the same setting (another `gh auth
  // login`, a new PAT), so the login is read on every refresh. A different one
  // rebuilds now. One that cannot be read proves nothing either way: the mirror
  // is withdrawn, and the next refresh the interval allows builds it again.
  const account = access.token ? ((await readAccount(access.token)) ?? null) : undefined;
  const accountUnknown = account === null;
  const accessChanged =
    state.access !== access.kind || (typeof account === "string" && state.account !== account);
  const withdrawn = (accessChanged || accountUnknown) && (await retireMirror(directory, mirror));
  if (retiredKinds.length > 0 || withdrawn) {
    log.info("git-mirror.access-changed", {
      projectId: project.id,
      access: access.kind,
      retired: (withdrawn ? [...retiredKinds, access.kind] : retiredKinds).join(","),
      accountUnknown,
    });
  }
  await removeScratch(directory);
  if (!options.force && !accessChanged) {
    if ((state.oversizedUntil ?? 0) > now()) return "skipped-oversized";
    if (now() - (state.lastAttemptAt ?? 0) < GIT_MIRROR_REFRESH_INTERVAL_MS) {
      return "skipped-recent";
    }
  }
  const remote = remoteFingerprint(project.gitUrl);
  const next: MirrorState = { ...state, remote, access: access.kind, lastAttemptAt: now() };
  if (account === undefined) delete next.account;
  else next.account = account;
  delete next.oversizedUntil;
  await writeState(directory, next);

  const exists = await isDirectory(path.join(mirror, "objects"));
  const verified = !exists || !state.suspect || (await hasValidConnectivity(mirror, run));
  const rebuild =
    !exists ||
    !verified ||
    accessChanged ||
    state.remote !== remote ||
    (state.failures ?? 0) >= GIT_MIRROR_REBUILD_AFTER_FAILURES;
  const free = await (options.freeBytes ?? availableBytes)(directory);
  if (free < GIT_MIRROR_MIN_FREE_BYTES + (rebuild ? maxBytes : 0)) {
    log.warn("git-mirror.low-disk", { projectId: project.id });
    return "skipped-low-disk";
  }

  const transfer: Transfer = {
    project,
    access,
    directory,
    run,
    controller,
    maxBytes,
    oversized: false,
    canSeed: free >= GIT_MIRROR_MIN_FREE_BYTES + GIT_MIRROR_SEED_LIMITS_FREE * maxBytes,
  };
  try {
    if (rebuild) {
      const built = await buildMirror(transfer, directory, mirror);
      if (built === "empty") {
        await writeState(directory, { ...next, failures: 0 });
        return "empty";
      }
    } else {
      await fetchInto(transfer, mirror);
      await compactMirror(project.id, mirror, run);
    }
    if ((await directoryBytes(mirror)) > maxBytes) {
      transfer.oversized = true;
      throw new Error("The mirror grew past its limit");
    }
  } catch (error) {
    if (transfer.oversized) {
      await retireMirror(directory, mirror);
      await writeState(directory, {
        ...next,
        failures: 0,
        suspect: false,
        oversizedUntil: now() + GIT_MIRROR_OVERSIZED_RETRY_MS,
      });
      log.warn("git-mirror.oversized", { projectId: project.id, maxBytes });
      return "oversized";
    }
    if (controller.signal.aborted) return "cancelled";
    await writeState(directory, { ...next, failures: (state.failures ?? 0) + 1 });
    log.warn("git-mirror.refresh-failed", {
      remediation: permissionRemediation(error),
      projectId: project.id,
      rebuild,
      // Git's own message can name the remote, credentials included.
      error: formatLogError(error, { message: false }),
    });
    return "failed";
  } finally {
    await removeScratch(directory).catch(() => undefined);
  }
  if (controller.signal.aborted) return "cancelled";
  await writeState(
    directory,
    { ...next, failures: 0, suspect: false },
    { revision: state.suspectRevision },
  );
  log.info("git-mirror.refreshed", {
    projectId: project.id,
    access: access.kind,
    rebuilt: rebuild,
  });
  return rebuild ? "built" : "fetched";
}

type Transfer = {
  project: MirrorProject;
  /** The access every remote fetch of this refresh uses. */
  access: GitMirrorAccess;
  /** The project directory, where each fetch gets its empty home. */
  directory: string;
  run: typeof runCommand;
  controller: AbortController;
  maxBytes: number;
  oversized: boolean;
  /** The disk has room for a seed's quarantine as well as the build. */
  canSeed: boolean;
};

/**
 * No template: a mirror has no hooks. 0644 keeps it readable by the workload
 * user under rootless Docker, whatever the backend's umask.
 */
async function initBareRepository(transfer: Transfer, gitDir: string): Promise<void> {
  await transfer.run(
    "git",
    ["init", "--quiet", "--bare", "--template=", "--shared=0644", "--initial-branch=main", gitDir],
    { timeoutMs: GIT_MIRROR_LOCAL_TIMEOUT_MS, env: gitLocalEnv() },
  );
}

/** Builds a new mirror beside the mount and renames it in, so no reader sees a partial one. */
async function buildMirror(
  transfer: Transfer,
  directory: string,
  mirror: string,
): Promise<"published" | "empty"> {
  const building = await mkdtemp(path.join(directory, ".building-"));
  const staged = path.join(building, GIT_MIRROR_NAME);
  if (!(await seedMirror(transfer, building, staged))) {
    await initBareRepository(transfer, staged);
    await fetchInto(transfer, staged);
  }
  const refs = await transfer.run(
    "git",
    [`--git-dir=${staged}`, "for-each-ref", "--count=1", "--format=%(objectname)", "refs/heads/"],
    { timeoutMs: GIT_MIRROR_LOCAL_TIMEOUT_MS, env: gitLocalEnv() },
  );
  if (!refs.stdout.trim()) return "empty";
  if ((await directoryBytes(staged)) > transfer.maxBytes) {
    transfer.oversized = true;
    throw new Error("The mirror is past its limit");
  }
  await retireMirror(directory, mirror);
  await rename(staged, mirror);
  return "published";
}

/**
 * Builds `staged` from the project's host checkout and the remote, or leaves
 * nothing and returns false, which means an ordinary download. A checkout can
 * hold unpushed work and refs and config shaped by whatever ran in it, so it only
 * ever saves bytes:
 *
 * - The checkout is read only through the `upload-pack` of a fetch, the one way
 *   into a repository that restricts what its config and hooks can run. Every
 *   object is hashed on the way in, and a fetch checks a ref's whole history.
 * - That goes into a quarantine beside the mirror, where the remote then decides
 *   which branches exist and where they point, and sends what is missing.
 * - The mirror fetches those branches from the quarantine, so it receives exactly
 *   what they reach, hashes fixing the content, and no other ref or object.
 */
async function seedMirror(transfer: Transfer, building: string, staged: string): Promise<boolean> {
  const { project, controller } = transfer;
  const checkout = transfer.canSeed ? await seedableCheckout(project) : null;
  if (!checkout) return false;
  const quarantine = path.join(building, "seed.git");
  try {
    await initBareRepository(transfer, quarantine);
    await fetchBoundedLocal(transfer, checkout, quarantine, SEED_REFSPEC);
    await fetchInto(transfer, quarantine, await packBytes(quarantine));
    await initBareRepository(transfer, staged);
    // The quarantine may contain a full seed plus a full remote increment.
    // Discard it before duplicating that data if it no longer fits one limit.
    if ((await directoryBytes(quarantine)) > transfer.maxBytes) {
      throw new Error("The seed and remote together exceed the mirror limit");
    }
    await fetchBoundedLocal(transfer, quarantine, staged, MIRROR_REFSPEC);
    log.info("git-mirror.seeded", { projectId: project.id });
    return true;
  } catch (error) {
    if (controller.signal.aborted) throw error;
    log.info("git-mirror.seed-skipped", {
      projectId: project.id,
      error: formatLogError(error, { message: false }),
    });
    await rm(staged, { recursive: true, force: true });
    return false;
  } finally {
    await rm(quarantine, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function seedableCheckout(project: MirrorProject): Promise<string | null> {
  const checkout = project.localPath;
  if (!checkout || !path.isAbsolute(checkout)) return null;
  const stats = await stat(checkout).catch(() => null);
  return stats?.isDirectory() ? checkout : null;
}

/**
 * Bounds either local copy in a seed. Exceeding this limit ends only the seed:
 * a plain remote download may still fit after discarding unreachable seed data.
 */
async function fetchBoundedLocal(
  transfer: Transfer,
  checkout: string,
  quarantine: string,
  refspec: string,
): Promise<void> {
  const limit = new AbortController();
  const guard = setInterval(() => {
    void packBytes(quarantine).then((bytes) => {
      if (bytes > transfer.maxBytes) limit.abort();
    });
  }, GIT_MIRROR_SIZE_CHECK_MS);
  guard.unref?.();
  try {
    await fetchLocal(transfer, checkout, quarantine, refspec, limit.signal);
  } finally {
    clearInterval(guard);
  }
  // A small fetch unpacks to loose objects, which the running guard does not see.
  if ((await directoryBytes(quarantine)) > transfer.maxBytes) {
    throw new Error("The checkout holds more than a mirror's limit");
  }
}

/**
 * A fetch between repositories on this disk. Local protocol only: an older Git's
 * `upload-pack` can fetch missing objects for a partial clone, from wherever that
 * repository's config says.
 */
async function fetchLocal(
  transfer: Transfer,
  source: string,
  gitDir: string,
  refspec: string,
  signal?: AbortSignal,
): Promise<void> {
  await transfer.run(
    "git",
    [
      `--git-dir=${gitDir}`,
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--",
      source,
      refspec,
    ],
    {
      cwd: path.dirname(gitDir),
      timeoutMs: GIT_MIRROR_LOCAL_TIMEOUT_MS,
      signal: signal
        ? AbortSignal.any([signal, transfer.controller.signal])
        : transfer.controller.signal,
      env: { ...gitLocalEnv(), GIT_ALLOW_PROTOCOL: "file", GIT_NO_LAZY_FETCH: "1" },
    },
  );
}

/**
 * Fetches every branch the way a container of the transfer's access would, so
 * the mirror never holds what its readers could not fetch themselves (see
 * `gitMirrorFetchPlan`), stopping the transfer if it passes the size limit.
 * `seedBytes` is what the repository held before, which the remote did not send.
 */
async function fetchInto(transfer: Transfer, gitDir: string, seedBytes = 0): Promise<void> {
  const { project, access, run, controller, maxBytes } = transfer;
  const home = await makeFetchHome(transfer.directory);
  const plan = gitMirrorFetchPlan(project.gitUrl, access, home);
  if (!plan) {
    await rm(home, { recursive: true, force: true });
    throw new Error("A container could not clone this remote");
  }
  const guard = setInterval(() => {
    void packBytes(gitDir).then((bytes) => {
      if (bytes - seedBytes > maxBytes) {
        transfer.oversized = true;
        controller.abort();
      }
    });
  }, GIT_MIRROR_SIZE_CHECK_MS);
  guard.unref?.();
  try {
    await run(
      "git",
      [
        `--git-dir=${gitDir}`,
        // Compaction runs below, in this writer, not detached behind it.
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        ...plan.gitOptions,
        "fetch",
        "--no-recurse-submodules",
        "--quiet",
        "--prune",
        "--no-tags",
        // FETCH_HEAD would record the remote in a directory the container reads.
        "--no-write-fetch-head",
        "--",
        plan.url,
        MIRROR_REFSPEC,
      ],
      {
        cwd: path.dirname(gitDir),
        timeoutMs: GIT_MIRROR_FETCH_TIMEOUT_MS,
        signal: controller.signal,
        redactValues: [project.gitUrl, plan.url],
        env: plan.env,
      },
    );
  } finally {
    clearInterval(guard);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Keeps repeated fetches from piling up packs. Git keeps old packs until new ones exist. */
async function compactMirror(
  projectId: string,
  gitDir: string,
  run: typeof runCommand,
): Promise<void> {
  try {
    const packs = (await readdir(path.join(gitDir, "objects", "pack"))).filter((name) =>
      name.endsWith(".pack"),
    );
    if (packs.length <= GIT_MIRROR_COMPACT_ABOVE_PACKS) return;
    await run("git", [`--git-dir=${gitDir}`, "gc", "--quiet", "--prune=2.weeks.ago"], {
      timeoutMs: GIT_MIRROR_LOCAL_TIMEOUT_MS,
      env: gitLocalEnv(),
    });
  } catch (error) {
    log.warn("git-mirror.compact-failed", {
      projectId,
      error: formatLogError(error, { message: false }),
    });
  }
}

async function hasValidConnectivity(gitDir: string, run: typeof runCommand): Promise<boolean> {
  try {
    await run("git", [`--git-dir=${gitDir}`, "fsck", "--connectivity-only", "--no-progress"], {
      timeoutMs: GIT_MIRROR_LOCAL_TIMEOUT_MS,
      env: gitLocalEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

/** Local plumbing reads no prompt and no remote. */
function gitLocalEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}

/** Moves a published mirror out of the mount; the next launch's clone goes to the remote. */
async function retireMirror(directory: string, mirror: string): Promise<boolean> {
  if (!(await isDirectory(mirror))) return false;
  const retired = await mkdtemp(path.join(directory, ".retired-"));
  await rename(mirror, path.join(retired, GIT_MIRROR_NAME));
  return true;
}

/**
 * Retires the mirror of every access kind but `kind`, and the legacy mount's,
 * keeping their directories: a stopped container still names its bind source.
 * Returns the kinds (and `legacy`) whose mirror went.
 */
async function retireOtherAccessMirrors(
  directory: string,
  kind: GitMirrorAccessKind,
): Promise<string[]> {
  const retired: string[] = [];
  if (await retireMirror(directory, path.join(directory, LEGACY_MOUNT, GIT_MIRROR_NAME))) {
    retired.push("legacy");
  }
  for (const other of GIT_MIRROR_ACCESS_KINDS) {
    if (other === kind) continue;
    if (await retireMirror(directory, path.join(directory, mountName(other), GIT_MIRROR_NAME))) {
      retired.push(other);
    }
  }
  return retired;
}

/** Every directory a container of the project can have been bound to. */
export function gitMirrorMountNames(): string[] {
  return [LEGACY_MOUNT, ...GIT_MIRROR_ACCESS_KINDS.map(mountName)];
}

/** What an earlier, interrupted refresh left, and what this one finished with. */
async function removeScratch(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (name.startsWith(".building-") || name.startsWith(".retired-")) {
      await rm(path.join(directory, name), { recursive: true, force: true });
    }
  }
}

async function isDirectory(target: string): Promise<boolean> {
  return lstat(target).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
}

async function availableBytes(directory: string): Promise<number> {
  const stats = await statfs(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** The pack directory holds a running transfer's temporary pack too. */
async function packBytes(gitDir: string): Promise<number> {
  return directoryBytes(path.join(gitDir, "objects", "pack")).catch(() => 0);
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await lstat(target).catch(() => null))?.size ?? 0;
  }
  return total;
}

/**
 * Logs how a clone used the mirror, from the setup script's output. A mirror
 * that could not serve a clone is verified before its next fetch.
 */
export async function noteGitMirrorCloneOutcome(
  output: string,
  dataDir: string,
  projectId: string,
): Promise<void> {
  const outcome = CLONE_OUTCOME_PATTERN.exec(output)?.[1];
  if (!outcome) return;
  if (outcome === "used") {
    log.info("git-mirror.clone-used", { projectId });
    return;
  }
  // The first environment of a project normally finds no mirror yet.
  log[outcome === "missing" ? "info" : "warn"]("git-mirror.clone-fallback", {
    projectId,
    reason: outcome,
  });
  if (!SUSPECT_OUTCOMES.has(outcome)) return;
  try {
    const directory = projectDirectory(dataDir, projectId);
    await writeState(
      directory,
      { ...(await readState(directory)), suspect: true, suspectRevision: randomUUID() },
      undefined,
      true,
    );
  } catch (error) {
    log.warn("git-mirror.state-write-failed", {
      projectId,
      error: formatLogError(error, { message: false }),
    });
  }
}

/**
 * Removes a project's mirror with the project: stops any refresh first. A
 * failure is logged and left to the orphan sweep, so it never blocks removing
 * the project.
 */
export async function removeProjectGitMirror(
  context: GitMirrorContext,
  projectId: string,
): Promise<void> {
  const dataDir = context.storage.getDataDir();
  try {
    const key = projectDirectory(dataDir, projectId);
    const writer = writers.get(key);
    writer?.controller.abort();
    await writer?.done;
    if (!(await isDirectory(key))) return;
    await removeConfinedDirectory(dataDir, `${GIT_MIRRORS_DIR}/${projectId}`);
  } catch (error) {
    log.warn("git-mirror.remove-failed", {
      remediation: permissionRemediation(error),
      projectId,
      error: formatLogError(error, { message: false }),
    });
  }
}

/**
 * Removes mirrors whose project no longer exists: a removal that failed or was
 * interrupted. `projectIds` must be complete, so the caller refuses a store it
 * cannot read rather than make every mirror look orphaned.
 */
export async function sweepOrphanedProjectGitMirrors(
  dataDir: string,
  projectIds: ReadonlySet<string>,
  minAgeMs: number,
  now: () => number = Date.now,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(path.join(dataDir, GIT_MIRRORS_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    if (!PROJECT_ID_PATTERN.test(name) || projectIds.has(name)) continue;
    const target = path.join(dataDir, GIT_MIRRORS_DIR, name);
    const stats = await lstat(target).catch(() => null);
    // Whole milliseconds on both sides: `mtimeMs` carries the filesystem's
    // sub-millisecond part and `Date.now()` does not, so a directory changed
    // in the current millisecond would otherwise read as younger than zero.
    if (!stats?.isDirectory() || now() - Math.floor(stats.mtimeMs) < minAgeMs) continue;
    try {
      await removeConfinedDirectory(dataDir, `${GIT_MIRRORS_DIR}/${name}`);
      removed += 1;
    } catch (error) {
      log.warn("git-mirror.remove-failed", {
        remediation: permissionRemediation(error),
        projectId: name,
        error: formatLogError(error, { message: false }),
      });
    }
  }
  return removed;
}
