import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { HOST_TEST_SCHEDULER_SOURCE } from "@orkestrator/protocol/host-test-scheduler";

/**
 * Environment-side worker, launched with the application's Bun runtime from a
 * neutral cwd. It survives backend/renderer restarts. No repository dependency
 * or language runtime is required to supervise the project's own commands.
 * Keep this self-contained: the same source executes inside Docker.
 */
export const REVIEW_VALIDATION_WORKER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const input = JSON.parse(Buffer.from(process.argv[1], "base64").toString());
const { root, directory, run } = input;
const statePath = path.join(directory, "state.json");
const cancelPath = path.join(directory, "cancel");
const lockPath = path.join(path.dirname(directory), ".validation-lock");
const active = new Map();
const createScheduler = (${HOST_TEST_SCHEDULER_SOURCE});
let scheduler;
const tickets = new Set();
const QUEUE_TIMEOUT_MS = Math.max(1000, Math.min(7200000, Number(process.env.ORKESTRATOR_TEST_QUEUE_TIMEOUT_MS) || 1800000));
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
let totalBytes = 0;
let ownsLock = false;
let stopping = false;
let stateWrites = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function persist() {
  const temp = statePath + "." + process.pid + "." + (++stateWrites);
  fs.writeFileSync(temp, JSON.stringify({ run, heartbeat: Date.now(), pid: process.pid }), { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, statePath);
}
function killTree(child, signal) {
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}
function stop(reason) {
  stopping = true;
  for (const job of active.values()) job.stop(reason);
}
// Use the shared guard; evidence stores the failure without leaking the rejected
// value (which could contain command output) into application diagnostics.
(${installFatalRejectionGuard.toString()})({
  label: "[review-validation]",
  warn: () => { run.error = "Validation worker encountered an unhandled rejection"; stop(run.error); }
});
process.on("SIGTERM", () => { stop("Validation was cancelled"); });
process.on("SIGINT", () => { stop("Validation was cancelled"); });

function snapshotMatches() {
  const options = { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], options);
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], options);
  return head.status === 0 && head.stdout.trim() === run.plan.headRef && status.status === 0 && status.stdout.trim() === "";
}

async function execute(cmd, index) {
  const result = run.results[index];
  let ticket;
  const queuedAt = Date.now();
  result.status = "queued";
  result.queuedMs = 0;
  // Occupy this command's local slot even while it waits on the host. Otherwise
  // later commands could leapfrog its dependency/resource reservation.
  active.set(cmd.id, { cmd, stop: () => {} });
  const channel = path.join(directory, "scheduler-" + index + ".json");
  let cooperative = false;
  try {
    const configPath = path.join(root, ".orkestrator-test-scheduler.json");
    const stat = fs.lstatSync(configPath);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096 && cmd.cwd === ".") {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      cooperative = config.version === 1 && Array.isArray(config.cooperativeCommands) && config.cooperativeCommands.includes(cmd.command);
    }
  } catch {}
  try {
    if (!cooperative) {
      scheduler ??= createScheduler();
      const capacity = scheduler.capacity(), owner = scheduler.owner(root);
      const workers = cmd.weight === 2 ? capacity.workers : Math.max(1, Math.floor(capacity.workers / 2));
      ticket = scheduler.enqueue({ owner, workers, memoryMiB: Math.min(capacity.memoryMiB, workers * 1024),
        resources: cmd.resources.map(resource => resource === "*" ? "*" : "resource:" + createHash("sha256").update(resource).digest("hex")) });
      tickets.add(ticket);
      persist();
      while (scheduler.poll(ticket).state !== "running") {
        result.queuedMs = Date.now() - queuedAt;
        if (stopping) throw new Error("Validation was cancelled while queued");
        if (result.queuedMs >= QUEUE_TIMEOUT_MS) throw new Error("Host capacity wait expired; command did not run");
        await delay(100);
      }
    }
    result.queuedMs = Date.now() - queuedAt;
    if (stopping) throw new Error("Validation was cancelled before execution");
    if (!snapshotMatches()) {
      run.error = "Repository changed while validation was queued; rediscover against the current snapshot";
      stop(run.error);
      throw new Error(run.error);
    }
  const cwd = fs.realpathSync(path.resolve(root, cmd.cwd));
  if (cwd !== root && !cwd.startsWith(root + path.sep)) throw new Error("Validation working directory escapes the workspace");
  const ordinal = String(index + 1).padStart(2, "0");
  const streams = ["stdout", "stderr"].map(name => {
    const file = path.join(directory, "validation-" + ordinal + "." + name + ".txt");
    const fd = fs.openSync(file, "wx", 0o600);
    result[name + "Path"] = path.relative(root, file).split(path.sep).join("/");
    return { name, file, fd, hash: createHash("sha256"), bytes: 0 };
  });
  result.status = "running";
  result.startedAt = new Date().toISOString();
  const started = performance.now();
  persist();
  await new Promise(resolve => {
    const shell = "( while kill -0 \"$2\" 2>/dev/null; do sleep 1; done; kill -KILL -- -$$ ) </dev/null >/dev/null 2>&1 & __orkestrator_validation_watchdog=$!; trap 'kill \"$__orkestrator_validation_watchdog\" 2>/dev/null || true' EXIT; eval \"$1\"";
    // Do not leak an outer command's cooperative channel into unrelated nested
    // runners. A declared cooperative command owns this private channel only.
    const env = { ...process.env };
    delete env.ORKESTRATOR_VALIDATION_SCHEDULER_STATE;
    delete env.ORKESTRATOR_VALIDATION_HEAD_REF;
    delete env.ORKESTRATOR_TEST_PARENT_RESERVATION;
    delete env.ORKESTRATOR_VALIDATION_RESOURCES;
    if (!cooperative) env.ORKESTRATOR_TEST_PARENT_RESERVATION = run.id;
    if (cooperative) env.ORKESTRATOR_VALIDATION_RESOURCES = JSON.stringify(cmd.resources.map(resource => resource === "*" ? "*" : "resource:" + createHash("sha256").update(resource).digest("hex")));
    if (cooperative) { env.ORKESTRATOR_VALIDATION_SCHEDULER_STATE = channel; env.ORKESTRATOR_VALIDATION_HEAD_REF = run.plan.headRef; }
    const child = spawn("bash", ["-lc", shell, "review-validation", cmd.command, String(process.pid)], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let failure;
    let forceKill;
    const stopJob = reason => {
      if (failure) return;
      failure = reason;
      killTree(child, "SIGTERM");
      forceKill = setTimeout(() => killTree(child, "SIGKILL"), 1000);
    };
    active.set(cmd.id, { cmd, stop: stopJob });
    try { if (ticket && child.pid) scheduler.registerChild(ticket, child.pid); }
    catch { stopJob("Validation reservation could not record its child; evidence is incomplete"); }
    let projection;
    const updateClock = () => {
      if (!cooperative) return;
      try {
        const stat = fs.lstatSync(channel);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error();
        const value = JSON.parse(fs.readFileSync(channel, "utf8"));
        if (value.version !== 1 || !["queued", "running", "completed", "incomplete"].includes(value.state) ||
            !Number.isSafeInteger(value.executionMs) || value.executionMs < 0 || !Number.isSafeInteger(value.queuedMs) || value.queuedMs < 0 ||
            !Number.isFinite(value.heartbeat) || Date.now() - value.heartbeat > 10000) throw new Error();
        projection = value;
        result.status = value.state === "queued" ? "queued" : "running";
        result.durationMs = value.executionMs;
        result.queuedMs = value.queuedMs;
        result.executionUpdatedAt = new Date(value.heartbeat).toISOString();
        if (value.queuedMs >= QUEUE_TIMEOUT_MS) stopJob("Host capacity wait expired; validation is incomplete");
        if (value.executionMs >= cmd.timeoutMs) stopJob("Validation command timed out");
      } catch {
        if (performance.now() - started > 10000) stopJob("Cooperative test runner stopped reporting scheduling progress; validation is incomplete");
      }
    };
    const timeout = cooperative ? setInterval(updateClock, 100) : setTimeout(() => stopJob("Validation command timed out"), cmd.timeoutMs);
    child.on("error", () => stopJob("Validation command could not start"));
    [child.stdout, child.stderr].forEach((source, i) => source.on("data", chunk => {
      if (failure) return;
      const stream = streams[i];
      const remaining = Math.max(0, Math.min(MAX_STREAM_BYTES - stream.bytes, MAX_TOTAL_BYTES - totalBytes));
      const bytes = chunk.subarray(0, remaining);
      try {
        // Synchronous bounded writes backpressure only this dedicated worker.
        let offset = 0;
        while (offset < bytes.length) offset += fs.writeSync(stream.fd, bytes, offset, bytes.length - offset);
        stream.hash.update(bytes);
        stream.bytes += bytes.length;
        totalBytes += bytes.length;
      } catch { stopJob("Validation artifact could not be written; evidence is incomplete"); }
      if (chunk.length > remaining) stopJob("Validation output limit exceeded; captured output is incomplete");
    }));
    child.on("close", code => {
      clearTimeout(timeout);
      updateClock();
      // Clean up descendants even if their parent exited without waiting for them.
      killTree(child, "SIGKILL");
      if (forceKill) clearTimeout(forceKill);
      result.exitCode = typeof code === "number" ? code : null;
      const unavailable = failure ?? (code === null ? "Validation command ended without an exit code" : code === 75 ? "Validation reported infrastructure unavailability (exit 75); inspect captured output" : cooperative && (!projection || !["completed", "incomplete"].includes(projection.state)) ? "Cooperative runner did not seal its scheduling result" : projection?.state === "incomplete" ? "One or more groups could not complete; inspect captured output" : null);
      result.status = unavailable ? "incomplete" : code === 0 ? "passed" : "failed";
      result.limitation = unavailable;
      result.durationMs = cooperative && projection ? projection.executionMs : Math.round(performance.now() - started);
      try {
        for (const stream of streams) {
          fs.closeSync(stream.fd);
          fs.chmodSync(stream.file, 0o400);
          result[stream.name + "Bytes"] = stream.bytes;
          result[stream.name + "Sha256"] = stream.hash.digest("hex");
        }
        persist();
      } catch {
        run.error = "Validation artifacts or completion could not be persisted";
        stop(run.error);
      } finally {
        active.delete(cmd.id);
        resolve();
      }
    });
  });
  } catch (error) {
    result.status = "incomplete";
    result.limitation = error.message || "Validation infrastructure was unavailable";
    result.queuedMs = Date.now() - queuedAt;
    persist();
  } finally {
    active.delete(cmd.id);
    if (ticket) { scheduler.release(ticket); tickets.delete(ticket); }
  }
}

async function main() {
  run.status = "running";
  if (fs.existsSync(cancelPath)) stopping = true;
  persist();
  const heartbeat = setInterval(() => {
    try {
      if (fs.existsSync(cancelPath)) stop("Validation was cancelled");
      persist();
    } catch { stop("Validation state could not be persisted"); }
  }, 500);
  const tasks = new Set();
  try {
    const queuedAt = Date.now();
    while (!ownsLock && !stopping) {
      try {
        fs.mkdirSync(lockPath, { mode: 0o700 }); ownsLock = true;
        fs.writeFileSync(path.join(lockPath, "owner"), run.id, { flag: "wx", mode: 0o600 });
      }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      if (!ownsLock) {
        run.queueReason = "Waiting for another validation in this workspace";
        if (Date.now() - queuedAt > QUEUE_TIMEOUT_MS) {
          for (const result of run.results) Object.assign(result, { status: "incomplete", queuedMs: Date.now() - queuedAt, limitation: "Workspace capacity wait expired; command did not run" });
          run.status = "completed";
          return;
        }
        await delay(100);
      }
    }
    delete run.queueReason;
    if (!stopping && !snapshotMatches()) throw new Error("Repository changed after discovery or is not clean; rediscover validation against the current snapshot");
    const pending = new Set(run.plan.commands.map((_, i) => i));
    while ((pending.size || tasks.size) && !stopping) {
      for (const index of Array.from(pending)) {
        const cmd = run.plan.commands[index];
        const dependencies = cmd.dependsOn.map(id => run.results.find(result => result.id === id));
        if (dependencies.some(result => ["pending", "queued", "running"].includes(result.status))) continue;
        if (dependencies.some(result => result.status !== "passed")) {
          Object.assign(run.results[index], { status: "skipped", limitation: "A prerequisite did not pass" });
          pending.delete(index);
          persist();
          continue;
        }
        const jobs = Array.from(active.values());
        if (jobs.reduce((sum, job) => sum + job.cmd.weight, 0) + cmd.weight > 2) continue;
        if (jobs.some(job => cmd.resources.includes("*") || job.cmd.resources.includes("*") || cmd.resources.some(resource => job.cmd.resources.includes(resource)))) continue;
        pending.delete(index);
        const task = execute(cmd, index).catch(() => {
          run.error = "Validation execution or artifact capture failed";
          stop(run.error);
        }).finally(() => tasks.delete(task));
        tasks.add(task);
      }
      if (tasks.size) await Promise.race([...tasks, delay(100)]);
      else if (pending.size && !stopping) throw new Error("Validation dependencies could not be scheduled");
    }
    if (stopping) stop("Validation was cancelled");
    await Promise.all(tasks);
    if (stopping) {
      for (const i of pending) Object.assign(run.results[i], { status: "skipped", limitation: "Validation was cancelled" });
      run.status = run.error ? "failed" : "cancelled";
    } else if (!snapshotMatches()) {
      run.status = "failed";
      run.error = "Repository changed during validation; results cannot certify the discovered snapshot";
    } else run.status = "completed";
  } catch (error) {
    stop("Validation worker stopped");
    await Promise.all(tasks);
    run.status = "failed";
    run.error = error.message;
  } finally {
    clearInterval(heartbeat);
    delete run.queueReason;
    for (const ticket of tickets) scheduler?.release(ticket);
    scheduler?.close();
    run.completedAt = new Date().toISOString();
    try { persist(); }
    finally { if (ownsLock) { fs.unlinkSync(path.join(lockPath, "owner")); fs.rmdirSync(lockPath); } }
  }
}
main().catch(() => { stop("Validation worker failed"); process.exitCode = 1; });
`;

/** Small synchronous control requests. They never transport command output. */
export const REVIEW_VALIDATION_CONTROL = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const input = JSON.parse(Buffer.from(process.argv[1], "base64").toString());
const root = fs.realpathSync(input.root);
const directory = path.join(root, ".orkestrator", "review-artifacts", input.run.id);
const statePath = path.join(directory, "state.json");
function confinedDirectory(target) {
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (!fs.lstatSync(current).isDirectory() || fs.realpathSync(current) !== current) throw new Error("Validation artifact directory is not confined");
  }
}
function read() {
  const stat = fs.lstatSync(statePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Invalid validation state file");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (state.run.id !== input.run.id || JSON.stringify(state.run.plan) !== JSON.stringify(input.run.plan)) throw new Error("Validation identity changed");
  if (["planned", "running"].includes(state.run.status) && Date.now() - state.heartbeat > 30000 && input.action !== "cancel") {
    throw new Error("Validation worker stopped reporting progress; execution is uncertain and will not be automatically repeated");
  }
  return state.run;
}
async function main() {
  confinedDirectory(directory);
  if (input.action === "cancel") {
    // Persistent tombstone also prevents a delayed launcher from starting work.
    fs.writeFileSync(path.join(directory, "cancel"), "", { mode: 0o600, flag: "a" });
    const deadline = Date.now() + 10000;
    while (fs.existsSync(statePath) && Date.now() < deadline) {
      const run = read();
      const record = JSON.parse(fs.readFileSync(statePath, "utf8"));
      let dead = false;
      if (record.pid) { try { process.kill(record.pid, 0); } catch (error) { dead = error.code === "ESRCH"; } }
      // The command's watchdog kills its process group when the worker dies.
      // Give that watchdog time to settle before permitting an explicit retry.
      if ((dead && Date.now() - record.heartbeat > 3000) || (!record.pid && Date.now() - record.heartbeat > 30000)) {
        run.status = "cancelled";
        run.completedAt = new Date().toISOString();
        run.error = "Validation worker stopped; unfinished command results are uncertain";
        const temp = statePath + ".cancel-" + process.pid;
        fs.writeFileSync(temp, JSON.stringify({ ...record, run }), { flag: "wx", mode: 0o600 });
        fs.renameSync(temp, statePath);
        const lock = path.join(path.dirname(directory), ".validation-lock");
        try {
          if (fs.readFileSync(path.join(lock, "owner"), "utf8") === run.id) {
            fs.unlinkSync(path.join(lock, "owner")); fs.rmdirSync(lock);
          }
        } catch {}
      }
      if (!["planned", "running"].includes(run.status)) { process.stdout.write(JSON.stringify(run)); return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (fs.existsSync(statePath)) throw new Error("Validation cancellation has not settled");
    process.stdout.write(JSON.stringify({ ...input.run, status: "cancelled", completedAt: new Date().toISOString() }));
    return;
  }
  if (!fs.existsSync(statePath)) {
    if (input.action !== "start") throw new Error("Validation state is missing; execution will not be automatically repeated");
    // Exactly one control process can claim the job, even across backend restarts.
    let claimed = false;
    try {
      fs.writeFileSync(statePath, JSON.stringify({ run: input.run, heartbeat: Date.now() }), { flag: "wx", mode: 0o600 });
      claimed = true;
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (claimed) {
      const payload = Buffer.from(JSON.stringify({ root, directory, run: input.run })).toString("base64");
      const child = spawn(process.execPath, ["-e", process.argv[2], payload], { cwd: "/", detached: true, stdio: "ignore", env: process.env });
      child.on("error", () => {});
      child.unref();
    }
  }
  process.stdout.write(JSON.stringify(read()));
}
main().catch(() => { process.stderr.write("Validation control failed; check that the workspace and runner are available and retry or cancel the review"); process.exitCode = 1; });
`;
