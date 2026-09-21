import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import {
  HOST_TEST_SCHEDULER_SOURCE,
  TEST_SCHEDULING_POLICY_SOURCE,
} from "@orkestrator/protocol/host-test-scheduler";
import {
  REVIEW_VALIDATION_ENVIRONMENT_CHANGE_PATH_MAX,
  REVIEW_VALIDATION_ENVIRONMENT_CHANGES_MAX,
} from "@orkestrator/protocol/review-workflow";

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
let policy = { cooperativeCommands: [], profiles: {} };
// Set when the repository's scheduling config was unusable. It is reported on
// the run but is not itself a run failure: every command still executes.
let schedulingLimitation;
const parseSchedulingPolicy = (${TEST_SCHEDULING_POLICY_SOURCE});
const tickets = new Set();
const QUEUE_TIMEOUT_MS = Math.max(1000, Math.min(7200000, Number(process.env.ORKESTRATOR_TEST_QUEUE_TIMEOUT_MS) || 1800000));
// A cooperative child does real setup before its first publish (shell profile,
// mise/toolchain resolution, transpilation). That is not a stalled runner, so it
// gets a generous window; only its last successful read is treated as stale.
const COOPERATIVE_STARTUP_MS = Math.max(1000, Math.min(600000, Number(process.env.ORKESTRATOR_COOPERATIVE_STARTUP_MS) || 60000));
const COOPERATIVE_STALE_MS = Math.max(1000, Math.min(600000, Number(process.env.ORKESTRATOR_COOPERATIVE_STALE_MS) || 10000));
const NO_PROGRESS_MS = Math.max(1000, Math.min(7200000, Number(process.env.ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS) || 300000));
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

function gitOptions() {
  return { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
}
function headMatches() {
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], gitOptions());
  return head.status === 0 && head.stdout.trim() === run.plan.headRef;
}
function worktreePaths() {
  const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], gitOptions());
  if (status.status !== 0) return null;
  const fields = status.stdout.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  const files = [];
  for (let index = 0; index < fields.length;) {
    const entry = fields[index++];
    if (!entry || entry.length < 4 || entry[2] !== " ") return null;
    const statusCode = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (statusCode.includes("R") || statusCode.includes("C")) {
      const destination = fields[index++];
      if (!destination) return null;
      files.push(destination);
    }
  }
  return files;
}
const seenDriftPaths = new Set();
function recordEnvironmentChanges(files) {
  if (!files || files.length === 0) return;
  const recorded = Array.isArray(run.environmentChanges) ? run.environmentChanges.slice() : [];
  for (const file of recorded) seenDriftPaths.add(file);
  let omitted = Number.isSafeInteger(run.environmentChangesOmitted) ? run.environmentChangesOmitted : 0;
  for (const file of files) {
    if (typeof file !== "string" || file.length === 0 || file.length > ${REVIEW_VALIDATION_ENVIRONMENT_CHANGE_PATH_MAX}) continue;
    if (seenDriftPaths.has(file)) continue;
    seenDriftPaths.add(file);
    if (recorded.length < ${REVIEW_VALIDATION_ENVIRONMENT_CHANGES_MAX}) recorded.push(file);
    else omitted++;
  }
  recorded.sort();
  run.environmentChanges = recorded;
  if (omitted > 0) run.environmentChangesOmitted = omitted;
  else delete run.environmentChangesOmitted;
}
function noteWorktreeDrift() {
  const files = worktreePaths();
  if (files === null) throw new Error("Git status could not be read; rediscover validation against the current snapshot");
  recordEnvironmentChanges(files);
}

async function execute(cmd, index) {
  const result = run.results[index];
  let ticket;
  let streams = [];
  const queuedAt = Date.now();
  result.status = "queued";
  result.queuedMs = 0;
  const cooperative = cmd.cwd === "." && policy.cooperativeCommands.includes(cmd.command);
  const profile = cmd.cwd === "." ? policy.profiles[cmd.command] ?? {} : {};
  // Occupy this command's local slot even while it waits on the host. Otherwise
  // later commands could leapfrog its dependency/resource reservation. A
  // cooperative command admits itself inside its child, so it does not consume
  // this worker's weight budget until that admission reports it running; a
  // weight-2 cooperative child would otherwise stall unrelated local work for
  // the whole host wait.
  active.set(cmd.id, { cmd, stop: () => {}, weight: cooperative ? 0 : cmd.weight });
  const channel = path.join(directory, "scheduler-" + index + ".json");
  try {
    scheduler ??= createScheduler();
    const capacity = scheduler.capacity(), owner = scheduler.owner(root);
    const resources = scheduler.resources(owner, cmd.resources);
    if (!cooperative) {
      const suiteBudget = Math.min(8, capacity.workers);
      // A profile declares what the command wants, not what this host has. Clamp
      // both estimates into the frozen budget: enqueue rejects an over-budget
      // request outright, which would make the command permanently incomplete on
      // a small host instead of simply reserving everything available.
      const workers = Math.max(1, Math.min(suiteBudget, profile.workers ?? (cmd.weight === 2 ? suiteBudget : Math.max(1, Math.floor(suiteBudget / 2)))));
      ticket = scheduler.enqueue({ owner, workers, memoryMiB: Math.max(1, Math.min(capacity.memoryMiB, profile.memoryMiB ?? workers * 1024)), resources });
      tickets.add(ticket);
      persist();
      while (true) {
        const status = scheduler.poll(ticket);
        result.queueReason = status.queueReason;
        if (status.state === "running") break;
        result.queuedMs = Date.now() - queuedAt;
        if (stopping) throw new Error("Validation was cancelled while queued");
        if (result.queuedMs >= QUEUE_TIMEOUT_MS) throw new Error("Host capacity wait expired; command did not run");
        await delay(100);
      }
    }
    result.queuedMs = Date.now() - queuedAt;
    if (stopping) throw new Error("Validation was cancelled before execution");
    if (!headMatches()) {
      run.error = "Repository HEAD changed while validation was queued; rediscover against the current snapshot";
      stop(run.error);
      throw new Error(run.error);
    }
    noteWorktreeDrift();
  const cwd = fs.realpathSync(path.resolve(root, cmd.cwd));
  if (cwd !== root && !cwd.startsWith(root + path.sep)) throw new Error("Validation working directory escapes the workspace");
  const ordinal = String(index + 1).padStart(2, "0");
  // Open both artifacts before recording either path. A one-sided pair is
  // rejected by the preparation contract, so failing the second open must not
  // leave a path a reviewer would be told to read.
  try {
    for (const name of ["stdout", "stderr"]) {
      const file = path.join(directory, "validation-" + ordinal + "." + name + ".txt");
      const fd = fs.openSync(file, "wx", 0o600);
      streams.push({ name, file, fd, hash: createHash("sha256"), bytes: 0 });
    }
  } catch (error) {
    for (const stream of streams) { try { fs.closeSync(stream.fd); } catch {} try { fs.unlinkSync(stream.file); } catch {} }
    streams.length = 0;
    throw error;
  }
  for (const stream of streams) result[stream.name + "Path"] = path.relative(root, stream.file).split(path.sep).join("/");
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
    if (cooperative) env.ORKESTRATOR_VALIDATION_RESOURCES = JSON.stringify(resources);
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
    active.set(cmd.id, { cmd, stop: stopJob, weight: cooperative ? 0 : cmd.weight });
    try { if (ticket && child.pid) scheduler.registerChild(ticket, child.pid); }
    catch { stopJob("Validation reservation could not record its child; evidence is incomplete"); }
    let projection;
    let legacyAt = performance.now(), legacyExecutionMs = 0, legacyQueuedMs = 0;
    // Measure staleness from the last successful read, not from spawn. Before
    // the first publish the channel does not exist, so every read fails; a cold
    // startup must not be mistaken for a dead runner.
    let lastProgressAt = started;
    const updateClock = () => {
      if (!cooperative) return;
      try {
        const stat = fs.lstatSync(channel);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error();
        const value = JSON.parse(fs.readFileSync(channel, "utf8"));
        if (value.version !== 1 || !["queued", "running", "completed", "incomplete"].includes(value.state) ||
            !Number.isSafeInteger(value.executionMs) || value.executionMs < 0 || !Number.isSafeInteger(value.queuedMs) || value.queuedMs < 0 ||
            !Number.isFinite(value.heartbeat) || Date.now() - value.heartbeat > COOPERATIVE_STALE_MS) throw new Error();
        const readAt = performance.now();
        if (value.version === 1 && value.timing !== "wall") {
          // Old worktrees report summed group times. Integrate their state
          // locally instead of treating those totals as elapsed deadlines.
          if (projection?.state === "running") legacyExecutionMs += readAt - legacyAt;
          else if (projection?.state === "queued") legacyQueuedMs += readAt - legacyAt;
          value.executionMs = Math.floor(legacyExecutionMs);
          value.queuedMs = Math.floor(legacyQueuedMs);
        }
        legacyAt = readAt;
        projection = value;
        lastProgressAt = readAt;
        result.status = value.state === "queued" ? "queued" : "running";
        result.durationMs = value.executionMs;
        result.queuedMs = value.queuedMs;
        result.executionUpdatedAt = new Date(value.heartbeat).toISOString();
        result.queueReason = typeof value.queueReason === "string" && value.queueReason.length > 0 && value.queueReason.length <= 1024 ? value.queueReason : undefined;
        const job = active.get(cmd.id);
        if (job) job.weight = value.state === "running" ? cmd.weight : 0;
        if (value.queuedMs >= QUEUE_TIMEOUT_MS) stopJob("Host capacity wait expired; validation is incomplete");
        if (value.executionMs >= cmd.timeoutMs) stopJob("Validation command timed out");
      } catch {
        if (performance.now() - lastProgressAt > (projection ? COOPERATIVE_STALE_MS : COOPERATIVE_STARTUP_MS)) stopJob("Cooperative test runner stopped reporting scheduling progress; validation is incomplete");
      }
    };
    const timeout = cooperative ? setInterval(updateClock, 100) : setTimeout(() => stopJob("Validation command timed out"), cmd.timeoutMs);
    // A foreground server can be alive forever without advancing validation.
    // Start only after admission; queue time is never a no-output failure.
    let lastOutputAt = performance.now();
    const noProgress = cooperative ? undefined : setInterval(() => {
      if (performance.now() - lastOutputAt >= NO_PROGRESS_MS)
        stopJob("Validation command produced no output for " + NO_PROGRESS_MS + "ms; command may be stuck in a foreground service; validation is incomplete");
    }, Math.min(1000, NO_PROGRESS_MS / 4));
    child.on("error", () => stopJob("Validation command could not start"));
    [child.stdout, child.stderr].forEach((source, i) => source.on("data", chunk => {
      if (failure) return;
      if (chunk.length > 0) {
        lastOutputAt = performance.now();
        result.lastOutputAt = new Date().toISOString();
      }
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
      if (noProgress) clearInterval(noProgress);
      updateClock();
      // Clean up descendants even if their parent exited without waiting for them.
      killTree(child, "SIGKILL");
      if (forceKill) clearTimeout(forceKill);
      result.exitCode = typeof code === "number" ? code : null;
      const unavailable = failure ?? (code === null ? "Validation command ended without an exit code" : code === 75 ? "Validation reported infrastructure unavailability (exit 75); inspect captured output" : cooperative && (!projection || !["completed", "incomplete"].includes(projection.state)) ? "Cooperative runner did not seal its scheduling result" : projection?.state === "incomplete" ? "One or more groups could not complete; inspect captured output" : null);
      result.status = unavailable ? "incomplete" : code === 0 ? "passed" : "failed";
      delete result.queueReason;
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
    // A command that expired or was cancelled while queued never reaches the
    // close handler, so clear its last scheduler explanation here too.
    delete result.queueReason;
    // Never leave one artifact path without the other: preparation rejects a
    // one-sided pair, which would turn this failure into an unparseable result.
    result.stdoutPath = null;
    result.stderrPath = null;
    for (const stream of streams) { try { fs.closeSync(stream.fd); } catch {} try { fs.unlinkSync(stream.file); } catch {} }
    streams.length = 0;
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
    if (!stopping) {
      if (!headMatches()) throw new Error("Repository HEAD changed after discovery; rediscover validation against the current snapshot");
      noteWorktreeDrift();
    }
    const configPath = path.join(root, ".orkestrator-test-scheduler.json");
    try {
      const stat = fs.lstatSync(configPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error("it is not a regular file of at most 16384 bytes");
      policy = parseSchedulingPolicy(JSON.parse(fs.readFileSync(configPath, "utf8")));
    } catch (error) {
      // A broken repository config degrades scheduling; it must not destroy
      // every command's evidence. Fall back to no cooperative commands and no
      // profiles, and name the file on the run so the cause is visible.
      if (error.code !== "ENOENT") {
        policy = { cooperativeCommands: [], profiles: {} };
        schedulingLimitation = (".orkestrator-test-scheduler.json was ignored: " + (error.message || "it could not be read") + ". Cooperative scheduling and command profiles are unavailable for this run.").slice(0, 1024);
        run.error = schedulingLimitation;
      }
    }
    // Execution metadata is separate from the immutable discovered plan, whose
    // identity is checked on every reconnect by the controller.
    const commands = run.plan.commands.map(cmd => {
      const profile = cmd.cwd === "." ? policy.profiles[cmd.command] ?? {} : {};
      return { ...cmd, resources: profile.resources ?? cmd.resources, weight: profile.workers === 1 ? 1 : cmd.weight };
    });
    const coveredBy = new Map();
    const dependsOn = (index, target, seen = new Set()) => {
      if (seen.has(index)) return false;
      seen.add(index);
      if (coveredBy.has(index)) {
        const covering = coveredBy.get(index);
        return covering === target || dependsOn(covering, target, seen);
      }
      return commands[index].dependsOn.some(id => {
        const dependency = commands.findIndex(cmd => cmd.id === id);
        return dependency === target || dependsOn(dependency, target, seen);
      });
    };
    const candidates = commands.map((cmd, index) => ({ index, covers: cmd.cwd === "." ? policy.profiles[cmd.command]?.covers ?? [] : [] }))
      .sort((a, b) => b.covers.length - a.covers.length || a.index - b.index);
    for (const candidate of candidates) {
      if (coveredBy.has(candidate.index)) continue;
      for (const [index, cmd] of commands.entries()) {
        if (index !== candidate.index && cmd.cwd === "." && !coveredBy.has(index) && !Array.from(coveredBy.values()).includes(index) && candidate.covers.includes(cmd.command) && !dependsOn(candidate.index, index) && cmd.dependsOn.every(id => dependsOn(candidate.index, commands.findIndex(dependency => dependency.id === id)))) coveredBy.set(index, candidate.index);
      }
    }
    const pending = new Set(commands.map((_, i) => i));
    while ((pending.size || tasks.size) && !stopping) {
      for (const index of Array.from(pending)) {
        const cmd = commands[index];
        const coveringIndex = coveredBy.get(index);
        if (coveringIndex !== undefined) {
          const covering = run.results[coveringIndex];
          if (["pending", "queued", "running"].includes(covering.status)) continue;
          Object.assign(run.results[index], { status: covering.status === "passed" ? "skipped" : "incomplete", limitation: covering.status === "passed" ? "Covered by " + covering.id + " (repository-declared coverage)" : "Covering validation " + covering.id + " did not pass" });
          pending.delete(index);
          persist();
          continue;
        }
        const dependencies = cmd.dependsOn.map(id => {
          const dependency = commands.findIndex(cmd => cmd.id === id);
          return run.results[coveredBy.get(dependency) ?? dependency];
        });
        if (dependencies.some(result => ["pending", "queued", "running"].includes(result.status))) continue;
        if (dependencies.some(result => result.status !== "passed")) {
          Object.assign(run.results[index], { status: "skipped", limitation: "A prerequisite did not pass" });
          pending.delete(index);
          persist();
          continue;
        }
        const jobs = Array.from(active.values());
        if (jobs.reduce((sum, job) => sum + job.weight, 0) + cmd.weight > 2) continue;
        if (jobs.some(job => cmd.resources.some(resource => ["*", "workspace:*", "host:*"].includes(resource)) || job.cmd.resources.some(resource => ["*", "workspace:*", "host:*"].includes(resource)) || cmd.resources.some(resource => job.cmd.resources.includes(resource)))) continue;
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
      run.status = run.error && run.error !== schedulingLimitation ? "failed" : "cancelled";
    } else if (!headMatches()) {
      run.status = "failed";
      run.error = "Repository HEAD changed during validation; results cannot certify the discovered snapshot";
    } else {
      noteWorktreeDrift();
      run.status = "completed";
    }
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
