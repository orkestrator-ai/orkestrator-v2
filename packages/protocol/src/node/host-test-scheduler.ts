/**
 * Cooperative host admission. SQLite owns the cross-process transaction lock;
 * no renderer or daemon needs to stay alive to preserve a queue position.
 * Keep the factory self-contained: validation workers embed its compiled body.
 */
export function createHostTestScheduler(
  options: {
    directory?: string;
    workers?: number;
    memoryMiB?: number;
  } = {},
  runtimeRequire: NodeJS.Require = require,
) {
  // Inject the fresh worker's require when serializing this factory: bundled
  // code's default can refer to a helper belonging to the parent's bundle.
  const { Database } = runtimeRequire("bun:sqlite") as typeof import("bun:sqlite");
  const fs = runtimeRequire("node:fs") as typeof import("node:fs");
  const os = runtimeRequire("node:os") as typeof import("node:os");
  const path = runtimeRequire("node:path") as typeof import("node:path");
  const { randomUUID, createHash } = runtimeRequire("node:crypto") as typeof import("node:crypto");
  const { spawnSync } = runtimeRequire("node:child_process") as typeof import("node:child_process");
  const birth = (pid: number): string | null => {
    try {
      if (process.platform === "linux") {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
      }
      const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 4096,
        env: { ...process.env, LC_ALL: "C" },
      });
      return result.status === 0 ? result.stdout.trim() || null : null;
    } catch {
      return null;
    }
  };
  const positive = (value: unknown, fallback: number, max: number) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? Math.min(number, max) : fallback;
  };
  // The owner pid never changes for this factory, so its birth token is read
  // once instead of spawning `ps` on every enqueue.
  const selfBorn = birth(process.pid);
  // Slots are admission estimates of average CPU use, not OS limits, so the
  // default ceiling is every logical core. Hosts may oversubscribe further
  // (up to four slots per core) when their workloads are mostly waiting.
  const cores = Math.max(1, os.availableParallelism());
  const hardwareMemory = Math.max(512, Math.floor((os.totalmem() / 1048576) * 0.65));
  const workers = positive(
    options.workers ?? process.env.ORKESTRATOR_TEST_HOST_WORKERS,
    Math.min(256, cores),
    Math.min(256, cores * 4),
  );
  const memoryMiB = positive(
    options.memoryMiB ?? process.env.ORKESTRATOR_TEST_HOST_MEMORY_MIB,
    hardwareMemory,
    hardwareMemory,
  );
  const directory =
    options.directory ??
    process.env.ORKESTRATOR_TEST_SCHEDULER_DIR ??
    path.join(os.tmpdir(), `orkestrator-test-scheduler-v1-${process.getuid?.() ?? "user"}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Test scheduler directory is not private");
  fs.chmodSync(directory, 0o700);
  const databasePath = path.join(directory, "queue.sqlite");
  if (fs.existsSync(databasePath) && fs.lstatSync(databasePath).isSymbolicLink())
    throw new Error("Invalid test scheduler database");
  const db = new Database(databasePath, { create: true });
  fs.chmodSync(databasePath, 0o600);
  db.exec(
    "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=1048576; PRAGMA wal_autocheckpoint=32;",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS jobs (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
    owner TEXT NOT NULL, pid INTEGER NOT NULL, pidBorn TEXT, child INTEGER,
    workers INTEGER NOT NULL, memory INTEGER NOT NULL, resources TEXT NOT NULL,
    state TEXT NOT NULL, queued INTEGER NOT NULL, admitted INTEGER
  ); CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, served INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK(id=1), workers INTEGER, memory INTEGER);
  CREATE TABLE IF NOT EXISTS usage (key TEXT NOT NULL, recorded INTEGER NOT NULL, parallelism REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS usage_key ON usage (key, recorded);`);
  type Job = {
    sequence: number;
    id: string;
    owner: string;
    pid: number;
    pidBorn: string | null;
    child: number | null;
    childBorn: string | null;
    cohort: string | null;
    bypasses: number;
    /** Current reservation: the preferred size while queued, the grant once admitted. */
    workers: number;
    /** Elastic floor; null (older rows) means the full preferred size. */
    minWorkers: number | null;
    memory: number;
    resources: string;
    state: string;
    queued: number;
    admitted: number | null;
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  const jobs = () => db.query<Job, []>("SELECT * FROM jobs ORDER BY sequence").all();
  const remove = (id: string) => db.query("DELETE FROM jobs WHERE id=?").run(id);
  const transaction = <T>(fn: () => T): T => db.transaction(fn).immediate();
  transaction(() => {
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(jobs)")
      .all()
      .map((column) => column.name);
    if (!columns.includes("childBorn")) db.exec("ALTER TABLE jobs ADD COLUMN childBorn TEXT");
    if (!columns.includes("cohort")) db.exec("ALTER TABLE jobs ADD COLUMN cohort TEXT");
    if (!columns.includes("bypasses"))
      db.exec("ALTER TABLE jobs ADD COLUMN bypasses INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("pidBorn")) db.exec("ALTER TABLE jobs ADD COLUMN pidBorn TEXT");
    if (!columns.includes("minWorkers")) db.exec("ALTER TABLE jobs ADD COLUMN minWorkers INTEGER");
  });
  const reap = () => {
    // Reading a pid's birth token costs a process spawn, so read each distinct
    // pid at most once per reap and short-circuit the common same-process owner.
    const births = new Map<number, string | null>();
    for (const job of jobs()) {
      // A bare pid is not identity: a dead owner's pid can be reused by an
      // unrelated long-lived process, which would strand this reservation
      // forever. Only trust the owner when its birth token still matches; when
      // birth is unknown on either side, retain capacity rather than risk
      // running alongside a live owner.
      if (job.state !== "draining" && alive(job.pid)) {
        if (job.pid === process.pid && job.pidBorn === selfBorn) continue;
        if (!births.has(job.pid)) births.set(job.pid, birth(job.pid));
        const currentBirth = births.get(job.pid);
        if (!job.pidBorn || !currentBirth || job.pidBorn === currentBirth) continue;
      }
      // A runner killed mid-turn may leave its detached process group alive.
      // Drain that exact registered group before lending its capacity again.
      if (job.child && alive(process.platform === "win32" ? job.child : -job.child)) {
        if (alive(job.child)) {
          const currentBirth = birth(job.child);
          // If identity is uncertain, retain capacity. If the PID was reused,
          // the old group is gone; never signal the unrelated replacement.
          if (!job.childBorn || !currentBirth) continue;
          if (job.childBorn !== currentBirth) {
            remove(job.id);
            continue;
          }
        }
        try {
          process.kill(process.platform === "win32" ? job.child : -job.child, "SIGKILL");
        } catch {}
        continue;
      }
      remove(job.id);
    }
    db.exec("DELETE FROM owners WHERE id NOT IN (SELECT owner FROM jobs)");
  };
  transaction(() => {
    reap();
    if (!jobs().length) db.exec("DELETE FROM budget");
    db.query("INSERT OR IGNORE INTO budget VALUES (1, ?, ?)").run(workers, memoryMiB);
    // Freeze the budget for an active epoch. Lowering it underneath an already
    // queued large request would strand that request forever.
  });
  const limits = () =>
    db
      .query<{ workers: number; memory: number }, []>(
        "SELECT workers, memory FROM budget WHERE id=1",
      )
      .get()!;
  const conflict = (a: string, b: string, aOwner: string, bOwner: string) => {
    const left = JSON.parse(a) as string[],
      right = JSON.parse(b) as string[];
    return (
      left.includes("*") ||
      right.includes("*") ||
      left.includes(`workspace:${bOwner}:*`) ||
      right.includes(`workspace:${aOwner}:*`) ||
      left.some((value) =>
        right.some(
          (other) =>
            value === other ||
            (value.endsWith(":*") && other.startsWith(value.slice(0, -1))) ||
            (other.endsWith(":*") && value.startsWith(other.slice(0, -1))),
        ),
      )
    );
  };
  // Smallest reservation a job may start with. CPU slots are elastic: a job
  // starts with whatever is free above this floor. Memory and exclusive
  // resources are not elastic and must fit whole.
  const floor = (job: Job) => Math.max(1, Math.min(job.workers, job.minWorkers ?? job.workers));
  // A blocked job may be overtaken by a competing later job this many times.
  // After that it reserves the host until it fits, so backfill cannot starve it.
  const MAX_BYPASSES = 32;
  const admit = () => {
    reap();
    while (true) {
      const all = jobs(),
        running = all.filter((job) => job.state !== "queued");
      const pending = all.filter((job) => job.state === "queued");
      if (!pending.length) return;
      const served = new Map(
        db
          .query<{ id: string; served: number }, []>("SELECT * FROM owners")
          .all()
          .map((row) => [row.id, row.served]),
      );
      // Round robin across worktrees, FIFO within each worktree.
      pending.sort(
        (a, b) => served.get(a.owner)! - served.get(b.owner)! || a.sequence - b.sequence,
      );
      const budget = limits();
      const freeWorkers = budget.workers - running.reduce((sum, job) => sum + job.workers, 0);
      const freeMemory = budget.memory - running.reduce((sum, job) => sum + job.memory, 0);
      const conflicts = (candidate: Job, job: Job) =>
        (!candidate.cohort || job.cohort !== candidate.cohort || job.owner !== candidate.owner) &&
        conflict(job.resources, candidate.resources, job.owner, candidate.owner);
      const starved = (job: Job) => freeWorkers < floor(job) || freeMemory < job.memory;
      const grant = (candidate: Job) =>
        starved(candidate) || running.some((job) => conflicts(candidate, job))
          ? 0
          : Math.min(candidate.workers, freeWorkers);
      // Later jobs backfill around blocked ones. Overtaking only counts against
      // a blocked job when it competes: for capacity the blocked job is short
      // of, or for one of its exclusive resources. A job waiting on a lock that
      // the backfill does not touch loses nothing.
      const skipped: Job[] = [];
      let next: Job | undefined,
        granted = 0,
        charged: Job[] = [];
      for (const candidate of pending) {
        const size = grant(candidate);
        const competing = skipped.filter((job) => starved(job) || conflicts(candidate, job));
        if (size && competing.every((job) => job.bypasses < MAX_BYPASSES)) {
          next = candidate;
          granted = size;
          charged = competing;
          break;
        }
        skipped.push(candidate);
      }
      if (!next) return;
      for (const job of charged)
        db.query("UPDATE jobs SET bypasses=bypasses+1 WHERE id=?").run(job.id);
      db.query("UPDATE jobs SET state='running', admitted=?, workers=? WHERE id=?").run(
        Date.now(),
        granted,
        next.id,
      );
      const turn = Math.max(0, ...served.values()) + 1;
      db.query("UPDATE owners SET served=? WHERE id=?").run(turn, next.owner);
    }
  };
  return {
    directory,
    capacity: () => ({ workers: limits().workers, memoryMiB: limits().memory }),
    owner: (workspace: string) =>
      createHash("sha256").update(fs.realpathSync(workspace)).digest("hex"),
    resources(owner: string, labels: string[]) {
      return labels.map((label) => {
        // Preserve the meaning of already-discovered legacy plans. New plans
        // and repository profiles explicitly opt into workspace scope.
        if (label === "*" || label === "host:*") return "*";
        if (!label.startsWith("workspace:")) {
          const host = label.startsWith("host:") ? label.slice(5) : label;
          return "resource:" + createHash("sha256").update(host).digest("hex");
        }
        const local = label.slice(10);
        return (
          "workspace:" +
          owner +
          ":" +
          (local === "*" ? "*" : createHash("sha256").update(local).digest("hex"))
        );
      });
    },
    enqueue(request: {
      owner: string;
      /** Preferred slots; the job may start with fewer, down to minWorkers. */
      workers: number;
      /** Elastic floor. Omitted means the job needs all of `workers`. */
      minWorkers?: number;
      memoryMiB: number;
      resources?: string[];
      cohort?: string;
    }) {
      const id = randomUUID();
      transaction(() => {
        reap();
        const budget = limits();
        if (jobs().length >= 256)
          throw new Error("Test capacity queue is full; validation is unavailable");
        if (
          !/^[a-f0-9]{64}$/.test(request.owner) ||
          !Number.isSafeInteger(request.workers) ||
          request.workers < 1 ||
          request.workers > budget.workers ||
          (request.minWorkers !== undefined &&
            (!Number.isSafeInteger(request.minWorkers) ||
              request.minWorkers < 1 ||
              request.minWorkers > request.workers)) ||
          !Number.isSafeInteger(request.memoryMiB) ||
          request.memoryMiB < 1 ||
          request.memoryMiB > budget.memory ||
          (request.resources ?? []).length > 64 ||
          (request.cohort !== undefined && !/^[a-f0-9-]{36}$/.test(request.cohort)) ||
          (request.resources ?? []).some((r) => !/^(\*|[a-zA-Z0-9:_-]{1,158}(?::\*)?)$/.test(r))
        )
          throw new Error("Validation resource request exceeds the host budget");
        // New worktrees join the current virtual round, not round zero; an
        // endless stream of newcomers must not starve an existing waiter.
        db.query("INSERT OR IGNORE INTO owners SELECT ?, COALESCE(MIN(served), 0) FROM owners").run(
          request.owner,
        );
        db.query(
          "INSERT INTO jobs (id,owner,pid,pidBorn,workers,minWorkers,memory,resources,state,queued,cohort) VALUES (?,?,?,?,?,?,?,?,'queued',?,?)",
        ).run(
          id,
          request.owner,
          process.pid,
          selfBorn,
          request.workers,
          request.minWorkers ?? null,
          request.memoryMiB,
          JSON.stringify(request.resources ?? []),
          Date.now(),
          request.cohort ?? null,
        );
        admit();
      });
      return id;
    },
    poll(id: string) {
      return transaction(() => {
        admit();
        const job = jobs().find((job) => job.id === id && job.pid === process.pid);
        if (!job)
          throw new Error("Validation reservation is unavailable; execution will not be repeated");
        const running = jobs().filter((candidate) => candidate.state !== "queued");
        const budget = limits();
        const usedWorkers = running.reduce((sum, candidate) => sum + candidate.workers, 0);
        const usedMemory = running.reduce((sum, candidate) => sum + candidate.memory, 0);
        const blocker = running.find(
          (candidate) =>
            (!job.cohort || candidate.cohort !== job.cohort || candidate.owner !== job.owner) &&
            conflict(candidate.resources, job.resources, candidate.owner, job.owner),
        );
        const reason = blocker
          ? `exclusive resource held by worktree ${blocker.owner.slice(0, 12)} (PID ${blocker.pid})`
          : usedWorkers + floor(job) > budget.workers
            ? "worker slots"
            : usedMemory + job.memory > budget.memory
              ? "estimated memory budget"
              : "an earlier request's fair turn";
        const needs =
          floor(job) < job.workers ? `${floor(job)}-${job.workers}` : String(job.workers);
        return {
          state: job.state as "queued" | "running",
          /** Slots held once running; the preferred size while queued. */
          workers: job.workers,
          queuedMs: (job.admitted ?? Date.now()) - job.queued,
          queueReason:
            job.state === "queued"
              ? `Waiting for ${reason}; ${usedWorkers}/${budget.workers} slots and ${usedMemory}/${budget.memory} MiB reserved; needs ${needs} slots and ${job.memory} MiB.`
              : undefined,
        };
      });
    },
    /**
     * Records one command's observed average CPU parallelism (CPU time over
     * wall time) under an opaque digest. History is bounded per key and host.
     */
    recordUsage(key: string, parallelism: number) {
      if (!/^[a-f0-9]{64}$/.test(key) || !Number.isFinite(parallelism) || parallelism < 0) return;
      transaction(() => {
        db.query("INSERT INTO usage VALUES (?,?,?)").run(
          key,
          Date.now(),
          Math.min(1024, parallelism),
        );
        db.query(
          "DELETE FROM usage WHERE key=? AND rowid NOT IN (SELECT rowid FROM usage WHERE key=? ORDER BY recorded DESC, rowid DESC LIMIT 10)",
        ).run(key, key);
        db.exec(
          "DELETE FROM usage WHERE rowid NOT IN (SELECT rowid FROM usage ORDER BY recorded DESC, rowid DESC LIMIT 4096)",
        );
      });
    },
    /** Slots a measured command needs: its busiest recent run, rounded up. */
    estimateWorkers(key: string): number | undefined {
      if (!/^[a-f0-9]{64}$/.test(key)) return undefined;
      const row = db
        .query<{ peak: number | null }, [string]>(
          "SELECT MAX(parallelism) AS peak FROM (SELECT parallelism FROM usage WHERE key=? ORDER BY recorded DESC, rowid DESC LIMIT 5)",
        )
        .get(key);
      return row?.peak == null ? undefined : Math.max(1, Math.ceil(row.peak));
    },
    registerChild(id: string, child: number) {
      if (!Number.isSafeInteger(child) || child <= 1) throw new Error("Invalid child process");
      db.query("UPDATE jobs SET child=?, childBorn=? WHERE id=? AND pid=? AND state='running'").run(
        child,
        birth(child),
        id,
        process.pid,
      );
    },
    release(id: string) {
      transaction(() => {
        db.query("UPDATE jobs SET state='draining' WHERE id=? AND pid=?").run(id, process.pid);
        admit();
      });
    },
    close() {
      db.close();
    },
  };
}

export const HOST_TEST_SCHEDULER_SOURCE = `(options) => (${createHostTestScheduler.toString()})(options, require)`;

/** Exact, repository-owned declarations; never infer coverage from command names. */
export function testSchedulingPolicy(config: unknown) {
  type Profile = {
    resources?: string[];
    workers?: number;
    /** Elastic floor for `workers`; the command may start with this many. */
    minWorkers?: number;
    memoryMiB?: number;
    covers?: string[];
    noProgressTimeoutMs?: number;
  };
  const profiles: Record<string, Profile> = Object.create(null);
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Invalid test scheduling configuration");
  const value = config as Record<string, unknown>;
  const strings = (input: unknown): input is string[] =>
    Array.isArray(input) &&
    input.length <= 32 &&
    input.every((item) => typeof item === "string" && item.length > 0 && item.length <= 1024);
  if (value.version !== 1 || !strings(value.cooperativeCommands))
    throw new Error("Invalid cooperative test commands");
  if (value.commandProfiles !== undefined) {
    if (
      !value.commandProfiles ||
      typeof value.commandProfiles !== "object" ||
      Array.isArray(value.commandProfiles) ||
      Object.keys(value.commandProfiles).length > 32
    )
      throw new Error("Invalid test command profiles");
    for (const [command, entry] of Object.entries(value.commandProfiles)) {
      if (
        !command ||
        command.length > 1024 ||
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry)
      )
        throw new Error("Invalid test command profile");
      const profile = entry as Profile;
      if (
        (profile.resources !== undefined && !strings(profile.resources)) ||
        (profile.covers !== undefined && !strings(profile.covers)) ||
        (profile.workers !== undefined &&
          (!Number.isSafeInteger(profile.workers) ||
            profile.workers < 1 ||
            profile.workers > 64)) ||
        (profile.minWorkers !== undefined &&
          (!Number.isSafeInteger(profile.minWorkers) ||
            profile.minWorkers < 1 ||
            profile.minWorkers > (profile.workers ?? 64))) ||
        (profile.memoryMiB !== undefined &&
          (!Number.isSafeInteger(profile.memoryMiB) ||
            profile.memoryMiB < 1 ||
            profile.memoryMiB > 1048576)) ||
        (profile.noProgressTimeoutMs !== undefined &&
          (!Number.isSafeInteger(profile.noProgressTimeoutMs) ||
            profile.noProgressTimeoutMs < 1000 ||
            profile.noProgressTimeoutMs > 7200000))
      )
        throw new Error("Invalid test command profile");
      profiles[command] = profile;
    }
  }
  return { cooperativeCommands: value.cooperativeCommands, profiles };
}

export const TEST_SCHEDULING_POLICY_SOURCE = testSchedulingPolicy.toString();
