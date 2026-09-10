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
  const hardwareWorkers = Math.max(1, Math.min(8, os.availableParallelism() - 2));
  const hardwareMemory = Math.max(512, Math.floor((os.totalmem() / 1048576) * 0.65));
  const workers = positive(
    options.workers ?? process.env.ORKESTRATOR_TEST_HOST_WORKERS,
    hardwareWorkers,
    hardwareWorkers,
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
  CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK(id=1), workers INTEGER, memory INTEGER);`);
  type Job = {
    sequence: number;
    id: string;
    owner: string;
    pid: number;
    pidBorn: string | null;
    child: number | null;
    childBorn: string | null;
    cohort: string | null;
    workers: number;
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
    if (!columns.includes("pidBorn")) db.exec("ALTER TABLE jobs ADD COLUMN pidBorn TEXT");
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
  const conflict = (a: string, b: string) => {
    const left = JSON.parse(a) as string[],
      right = JSON.parse(b) as string[];
    return left.includes("*") || right.includes("*") || left.some((value) => right.includes(value));
  };
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
      // Round robin across worktrees, FIFO within each worktree. Reserve the
      // next owner's head if it cannot fit; backfilling would starve big jobs.
      pending.sort(
        (a, b) => served.get(a.owner)! - served.get(b.owner)! || a.sequence - b.sequence,
      );
      const next = pending[0]!,
        budget = limits();
      if (
        running.reduce((sum, job) => sum + job.workers, 0) + next.workers > budget.workers ||
        running.reduce((sum, job) => sum + job.memory, 0) + next.memory > budget.memory ||
        running.some(
          (job) =>
            (!next.cohort || job.cohort !== next.cohort) && conflict(job.resources, next.resources),
        )
      )
        return;
      db.query("UPDATE jobs SET state='running', admitted=? WHERE id=?").run(Date.now(), next.id);
      const turn = Math.max(0, ...served.values()) + 1;
      db.query("UPDATE owners SET served=? WHERE id=?").run(turn, next.owner);
    }
  };
  return {
    directory,
    capacity: () => ({ workers: limits().workers, memoryMiB: limits().memory }),
    owner: (workspace: string) =>
      createHash("sha256").update(fs.realpathSync(workspace)).digest("hex"),
    enqueue(request: {
      owner: string;
      workers: number;
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
          !Number.isSafeInteger(request.memoryMiB) ||
          request.memoryMiB < 1 ||
          request.memoryMiB > budget.memory ||
          (request.resources ?? []).length > 64 ||
          (request.cohort !== undefined && !/^[a-f0-9-]{36}$/.test(request.cohort)) ||
          (request.resources ?? []).some((r) => !/^(\*|[a-zA-Z0-9:_-]{1,160})$/.test(r))
        )
          throw new Error("Validation resource request exceeds the host budget");
        // New worktrees join the current virtual round, not round zero; an
        // endless stream of newcomers must not starve an existing waiter.
        db.query("INSERT OR IGNORE INTO owners SELECT ?, COALESCE(MIN(served), 0) FROM owners").run(
          request.owner,
        );
        db.query(
          "INSERT INTO jobs (id,owner,pid,pidBorn,workers,memory,resources,state,queued,cohort) VALUES (?,?,?,?,?,?,?,'queued',?,?)",
        ).run(
          id,
          request.owner,
          process.pid,
          selfBorn,
          request.workers,
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
        return {
          state: job.state as "queued" | "running",
          queuedMs: (job.admitted ?? Date.now()) - job.queued,
        };
      });
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
