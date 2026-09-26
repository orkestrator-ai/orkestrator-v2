/**
 * Environment-side supervisor for `environment.exec`, run with the
 * application's Bun runtime from a neutral cwd (on the host for local
 * environments, inside the container for container environments).
 *
 * The worker owns exactly one command: argv-preserving and non-PTY, in its
 * own process group, stdout/stderr streamed to separate bounded files. It
 * publishes its state atomically with a heartbeat, so the backend can
 * reconcile it after a restart and a recycled PID can never impersonate it.
 * It never re-runs anything: a worker that stops reporting is `lost`, and the
 * operation becomes interrupted rather than being retried.
 *
 * Keep both scripts self-contained (no imports beyond node builtins): the
 * same source executes inside Docker.
 */

export const EXEC_WORKER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const input = JSON.parse(Buffer.from(process.argv[1], "base64").toString());
const directory = input.directory;
const statePath = path.join(directory, "state.json");
const cancelPath = path.join(directory, "cancel");
let state = JSON.parse(fs.readFileSync(statePath, "utf8"));
let writes = 0;
function persist(patch) {
  state = { ...state, ...patch, heartbeat: Date.now() };
  const temp = statePath + "." + process.pid + "." + (++writes);
  fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, statePath);
}
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); } catch {}
}
async function drainGroup(pgid) {
  // Owned descendants must be gone before the result is final.
  if (!groupAlive(pgid)) return false;
  signalGroup(pgid, "SIGTERM");
  const termDeadline = Date.now() + 3000;
  while (groupAlive(pgid) && Date.now() < termDeadline) await new Promise(r => setTimeout(r, 100));
  if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
  const killDeadline = Date.now() + 5000;
  while (groupAlive(pgid) && Date.now() < killDeadline) await new Promise(r => setTimeout(r, 100));
  return true;
}
async function main() {
  if (fs.existsSync(cancelPath)) {
    persist({ status: "exited", cancelled: true, exitCode: null, signal: null, finishedAt: new Date().toISOString(), error: "Cancelled before start" });
    return;
  }
  const stdout = fs.openSync(path.join(directory, "stdout"), "a", 0o600);
  const stderr = fs.openSync(path.join(directory, "stderr"), "a", 0o600);
  // Resolve symlinks: the working directory must stay inside the workspace.
  try {
    const root = fs.realpathSync(input.root);
    const cwd = fs.realpathSync(input.cwd);
    if (cwd !== root && !cwd.startsWith(root + path.sep)) throw new Error("outside");
  } catch {
    persist({ status: "exited", exitCode: null, signal: null, spawnError: "cwd-outside-workspace", finishedAt: new Date().toISOString() });
    return;
  }
  const env = { ...process.env, ...input.env };
  for (const key of Object.keys(env)) if (key.startsWith("ORKESTRATOR_")) delete env[key];
  let child;
  try {
    child = spawn(input.argv[0], input.argv.slice(1), {
      cwd: input.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    persist({ status: "exited", exitCode: null, signal: null, spawnError: String(error && error.code || "spawn failed"), finishedAt: new Date().toISOString() });
    return;
  }
  let spawnError = null;
  child.on("error", (error) => { spawnError = String(error && error.code || "spawn failed"); });
  const pgid = child.pid;
  persist({ status: "running", childPid: child.pid || null, pgid: pgid || null, startedAt: new Date().toISOString() });
  const counts = { stdout: 0, stderr: 0 };
  let outputLimited = false;
  let timedOut = false;
  let cancelled = false;
  const pump = (stream, fd, name) => stream.on("data", (chunk) => {
    if (outputLimited) return;
    const room = input.maxOutputBytes - counts[name];
    const slice = chunk.length > room ? chunk.subarray(0, Math.max(0, room)) : chunk;
    if (slice.length > 0) { fs.writeSync(fd, slice); counts[name] += slice.length; }
    if (chunk.length > room) { outputLimited = true; if (pgid) signalGroup(pgid, "SIGTERM"); }
  });
  pump(child.stdout, stdout, "stdout");
  pump(child.stderr, stderr, "stderr");
  child.stdin.on("error", () => {});
  if (input.stdinBase64) child.stdin.end(Buffer.from(input.stdinBase64, "base64")); else child.stdin.end();
  const timer = setTimeout(() => { timedOut = true; if (pgid) signalGroup(pgid, "SIGTERM"); }, input.timeoutMs);
  const heartbeat = setInterval(() => {
    if (!cancelled && fs.existsSync(cancelPath)) { cancelled = true; if (pgid) signalGroup(pgid, "SIGTERM"); }
    persist({ stdoutBytes: counts.stdout, stderrBytes: counts.stderr });
  }, 1000);
  const stop = () => { cancelled = true; if (pgid) signalGroup(pgid, "SIGTERM"); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const [code, signal] = await new Promise((resolve) => {
    child.on("close", (c, s) => resolve([c, s]));
    // A spawn failure may emit "error" without a later "close".
    child.on("error", () => setTimeout(() => resolve([null, null]), 200));
  });
  clearTimeout(timer);
  let descendantsKilled = false;
  if (pgid) descendantsKilled = await drainGroup(pgid);
  clearInterval(heartbeat);
  fs.closeSync(stdout); fs.closeSync(stderr);
  persist({
    status: "exited",
    exitCode: typeof code === "number" ? code : null,
    signal: signal || null,
    timedOut, outputLimited, cancelled, descendantsKilled,
    spawnError,
    stdoutBytes: counts.stdout, stderrBytes: counts.stderr,
    finishedAt: new Date().toISOString(),
  });
}
main().catch((error) => {
  try { persist({ status: "exited", exitCode: null, signal: null, error: "Exec worker failed", finishedAt: new Date().toISOString() }); } catch {}
  process.exitCode = 1;
});
`;

/**
 * Short control operations: start (claim-once), status, cancel, output.
 * Command output never passes through here except for an explicit, bounded
 * `output` read.
 */
export const EXEC_CONTROL = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const input = JSON.parse(Buffer.from(process.argv[1], "base64").toString());
const directory = input.directory;
const statePath = path.join(directory, "state.json");
function ensureDirectory() {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Exec artifact directory is invalid");
}
function readState() {
  const info = fs.lstatSync(statePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error("Invalid exec state");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (state.operationId !== input.operationId) throw new Error("Exec identity changed");
  // A worker that stops reporting is lost, whatever its PID now names.
  if (state.status !== "exited" && Date.now() - state.heartbeat > 15000) state.status = "lost";
  return state;
}
function readWindow(name) {
  const file = path.join(directory, name);
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch (error) { if (error.code === "ENOENT") return { base64: "", offset: 0, totalBytes: 0 }; throw error; }
  try {
    const total = fs.fstatSync(fd).size;
    const max = Math.max(0, Math.min(input.maxBytes, 256 * 1024));
    let offset = input.tailBytes !== undefined ? Math.max(0, total - Math.min(input.tailBytes, max)) : Math.min(input.offset || 0, total);
    const length = Math.min(max, total - offset);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) { const n = fs.readSync(fd, buffer, read, length - read, offset + read); if (n === 0) break; read += n; }
    return { base64: buffer.subarray(0, read).toString("base64"), offset, totalBytes: total };
  } finally { fs.closeSync(fd); }
}
async function main() {
  if (input.action === "start") {
    ensureDirectory();
    let claimed = false;
    try {
      fs.writeFileSync(statePath, JSON.stringify({ version: 1, operationId: input.operationId, status: "starting", heartbeat: Date.now() }), { flag: "wx", mode: 0o600 });
      claimed = true;
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (claimed) {
      const payload = Buffer.from(JSON.stringify({ directory, root: input.root, argv: input.argv, cwd: input.cwd, env: input.env || {}, stdinBase64: input.stdinBase64, timeoutMs: input.timeoutMs, maxOutputBytes: input.maxOutputBytes })).toString("base64");
      const child = spawn(process.execPath, ["-e", process.argv[2], payload], { cwd: "/", detached: true, stdio: "ignore", env: process.env });
      child.on("error", () => {});
      child.unref();
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const temp = statePath + ".claim-" + process.pid;
      fs.writeFileSync(temp, JSON.stringify({ ...state, workerPid: child.pid || null }), { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, statePath);
    }
    process.stdout.write(JSON.stringify(readState()));
    return;
  }
  if (!fs.existsSync(statePath)) { process.stdout.write(JSON.stringify({ operationId: input.operationId, status: "missing" })); return; }
  if (input.action === "cancel") {
    fs.writeFileSync(path.join(directory, "cancel"), "", { mode: 0o600, flag: "a" });
    const deadline = Date.now() + 15000;
    let state = readState();
    while (state.status !== "exited" && state.status !== "lost" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
      state = readState();
    }
    process.stdout.write(JSON.stringify(state));
    return;
  }
  if (input.action === "output") {
    const state = readState();
    process.stdout.write(JSON.stringify({ state, window: readWindow(input.stream === "stderr" ? "stderr" : "stdout") }));
    return;
  }
  process.stdout.write(JSON.stringify(readState()));
}
main().catch((error) => { process.stderr.write("Exec control failed"); process.exitCode = 1; });
`;
