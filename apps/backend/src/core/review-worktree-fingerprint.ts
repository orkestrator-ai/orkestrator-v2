/**
 * Runs inside the environment so large diffs and untracked files are hashed at
 * their source instead of being copied through the backend command transport.
 * The script captures the state twice and refuses an unstable observation.
 *
 * Content hashing is opt-in (`fingerprint` as the first script argument).
 * Callers that only need HEAD and the uncommitted path set — the build
 * pipeline's validation guard compares path sets, not bytes — must not pay for
 * a full `git diff` plus every untracked file being read twice.
 *
 * Git's output goes to unlinked files rather than pipes, the same idea as
 * `runCommand` in `@orkestrator/protocol/node/command-capture`, which this script
 * cannot import because it has to stay self-contained for the container. Under
 * Bun a pipe reader can miss the end of a stream, and a local worktree runs this
 * under the managed Bun (docs/tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md).
 *
 * Every failure leaves through one of REVIEW_WORKTREE_PROBE_REASON_CODES.
 * The script never writes a repository path, a filename, or Git's own message
 * to stderr, because that text ends up in an operator-facing prompt; the code
 * is the whole diagnostic.
 */
export const REVIEW_WORKTREE_FINGERPRINT_SCRIPT = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const {
  closeSync, constants, fstatSync, openSync, promises: fs, readSync, unlinkSync,
} = require("node:fs");
const { createHash, randomBytes } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const MAX_STATUS_BYTES = 16 * 1024 * 1024;
const MAX_DIFF_BYTES = 256 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 256 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const WANT_FINGERPRINT = process.argv[1] === "fingerprint";

function coded(code) {
  const error = new Error(code);
  error.probeCode = code;
  return error;
}

// Set once a status read timed out: a hung fsmonitor daemon blocks every later
// read too, so the rest of this probe skips it.
let gitPrefix = [];
// Internal only; a status timeout is retried, never reported.
const STATUS_TIMEOUT = "status-timeout";
const STATUS_TIMEOUT_MS = 10000;

// Output is noticed by looking, because a file has no back-pressure.
const OUTPUT_CHECK_MS = 100;
const READ_CHUNK_BYTES = 64 * 1024;
// How long a killed child may take to report its exit. Past this the group has
// already had SIGKILL, so nothing more can be learned by waiting.
const REAP_WAIT_MS = 2000;
const EXIT_WATCH_MS = 1000;
const EXIT_WATCH_MAX_MS = 16000;

function openCaptureFile() {
  const name = path.join(
    os.tmpdir(),
    "orkestrator-probe-" + process.pid + "-" + randomBytes(8).toString("hex"),
  );
  const fd = openSync(
    name,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_APPEND,
    0o600,
  );
  try {
    unlinkSync(name);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// Synchronous, so no event can be lost. The caller has checked the size.
function readCapture(fd, consume) {
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  for (let offset = 0; ;) {
    const bytesRead = readSync(fd, chunk, 0, chunk.length, offset);
    if (bytesRead === 0) return;
    consume(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
}

// On macOS Bun can lose the exit itself, and the child waits as a zombie nothing
// reaps. Its wait status is still readable. Undefined means still running or unknown.
function zombieExitCode(pid) {
  const result = spawnSync("/bin/ps", ["-o", "stat=,xstat=", "-p", String(pid)], {
    timeout: 100, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return undefined;
  const match = /^Z\S*\s+([0-9a-f]+)\s*$/i.exec(String(result.stdout).trim());
  if (!match) return undefined;
  const status = Number.parseInt(match[1], 16);
  return status & 0x7f ? 128 + (status & 0x7f) : (status >> 8) & 0xff;
}

function git(args, options = {}) {
  return new Promise((resolve, reject) => {
    const captureFds = [];
    const releaseCapture = () => {
      for (const fd of captureFds.splice(0)) {
        try { closeSync(fd); } catch {}
      }
    };
    try {
      captureFds.push(openCaptureFile());
      captureFds.push(openCaptureFile());
    } catch (error) {
      releaseCapture();
      reject(error);
      return;
    }
    const [stdoutFd, stderrFd] = captureFds;
    // A hook can outlive Git. Own a new process group so timeout cleanup includes
    // hooks and their descendants.
    const grouped = process.platform !== "win32";
    const child = spawn("git", [...gitPrefix, ...args], {
      detached: grouped, stdio: ["ignore", stdoutFd, stderrFd],
    });
    // A lost exit must not hold this process open once the probe has answered.
    // The timers below keep it alive for as long as the probe is waiting.
    child.unref();
    const finished = new Promise(resolve => {
      child.once("exit", resolve);
      child.once("close", resolve);
    });
    const limit = options.captureLimit ?? options.hashLimit ?? 0;
    let settled = false;
    let exitWatch;
    const stopTimers = () => {
      clearTimeout(timer);
      clearInterval(outputCheck);
      clearTimeout(exitWatch);
    };
    const signalTree = (signal) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const fail = async (code, signal = "SIGKILL") => {
      if (settled) return;
      settled = true;
      stopTimers();
      if (grouped) signalTree(signal);
      if (grouped && signal === "SIGTERM") {
        // Give Git time to remove index.lock, then kill even if Git already
        // exited: a hook may ignore SIGTERM and still be running.
        await new Promise(resolve => setTimeout(resolve, 250));
        signalTree("SIGKILL");
      }
      if (!grouped && child.pid) {
        // Windows has no POSIX process groups. taskkill targets only the tree
        // rooted at this child; bound the helper as well.
        await new Promise(resolve => {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
          const deadline = setTimeout(() => {
            try { killer.kill(); } catch {}
            resolve();
          }, 1000);
          const done = () => { clearTimeout(deadline); resolve(); };
          killer.on("error", done);
          killer.on("close", done);
        });
        try { child.kill("SIGKILL"); } catch {}
      }
      await new Promise(resolve => {
        const deadline = setTimeout(resolve, REAP_WAIT_MS);
        finished.then(() => { clearTimeout(deadline); resolve(); });
      });
      releaseCapture();
      reject(coded(code));
    };
    const overLimit = () => {
      if (limit > 0 && fstatSync(stdoutFd).size > limit) return "too-large";
      if (fstatSync(stderrFd).size > MAX_STDERR_BYTES) return "git-failed";
      return undefined;
    };
    const checkOutput = () => {
      if (settled) return;
      let code;
      try {
        code = overLimit();
      } catch {
        code = "git-failed";
      }
      if (code) fail(code);
    };
    const onExit = (code) => {
      if (settled) return;
      // The limits are polled, so a short burst can only be seen here.
      checkOutput();
      if (settled) return;
      settled = true;
      stopTimers();
      if (code !== 0) {
        releaseCapture();
        reject(coded("git-failed"));
        return;
      }
      try {
        const chunks = [];
        readCapture(stdoutFd, (chunk) => {
          if (options.hash) options.hash.update(chunk);
          if (options.captureLimit) chunks.push(Buffer.from(chunk));
        });
        resolve(options.captureLimit ? Buffer.concat(chunks) : Buffer.alloc(0));
      } catch {
        reject(coded("git-failed"));
      } finally {
        releaseCapture();
      }
    };
    // SIGTERM lets git remove an index.lock it took before the daemon stalled.
    const timer = options.timeoutMs
      ? setTimeout(() => fail(STATUS_TIMEOUT, "SIGTERM"), options.timeoutMs)
      : undefined;
    const outputCheck = setInterval(checkOutput, OUTPUT_CHECK_MS);
    child.on("error", () => fail("git-missing"));
    child.once("exit", onExit);
    const watchForLostExit = (delayMs) => {
      exitWatch = setTimeout(() => {
        if (settled) return;
        const code = zombieExitCode(child.pid);
        if (code === undefined) watchForLostExit(Math.min(delayMs * 2, EXIT_WATCH_MAX_MS));
        else onExit(code);
      }, delayMs);
    };
    if (process.platform === "darwin" && child.pid) watchForLostExit(EXIT_WATCH_MS);
  });
}

function untrackedPaths(status) {
  const fields = status.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const entry = fields[index++];
    if (!entry || entry.length < 4 || entry[2] !== " ") throw coded("malformed-status");
    const state = entry.slice(0, 2);
    if (state === "??") paths.push(entry.slice(3));
    if ((state.includes("R") || state.includes("C")) && !fields[index++]) {
      throw coded("malformed-status");
    }
  }
  return paths;
}

async function hashUntrackedFile(hash, filePath, budget) {
  hash.update("untracked\0");
  hash.update(filePath, "utf8");
  hash.update("\0");
  const stat = await fs.lstat(filePath).catch(() => { throw coded("read-failed"); });
  hash.update(String(stat.mode));
  hash.update("\0");
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(filePath, { encoding: "buffer" })
      .catch(() => { throw coded("read-failed"); });
    budget.bytes += target.length;
    if (budget.bytes > MAX_UNTRACKED_BYTES) throw coded("too-large");
    hash.update("symlink\0");
    hash.update(target);
    return;
  }
  if (!stat.isFile()) {
    hash.update("other\0");
    return;
  }

  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => { throw coded("read-failed"); });
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw coded("unstable");
    hash.update("file\0");
    hash.update(String(opened.size));
    hash.update("\0");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      budget.bytes += chunk.length;
      if (budget.bytes > MAX_UNTRACKED_BYTES) {
        stream.destroy();
        throw coded("too-large");
      }
      hash.update(chunk);
    }
  } catch (error) {
    throw error && error.probeCode ? error : coded("read-failed");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function capture() {
  const head = (await git(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { captureLimit: 1024 },
  )).toString("utf8").trim();
  const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  const status = await git(
    statusArgs,
    { captureLimit: MAX_STATUS_BYTES, timeoutMs: gitPrefix.length ? 0 : STATUS_TIMEOUT_MS },
  ).catch((error) => {
    if (!error || error.probeCode !== STATUS_TIMEOUT) throw error;
    gitPrefix = ["-c", "core.fsmonitor=false"];
    return git(statusArgs, { captureLimit: MAX_STATUS_BYTES });
  });
  if (!WANT_FINGERPRINT) return { head, status, fingerprint: null };
  const hash = createHash("sha256");
  hash.update("head\0");
  hash.update(head, "utf8");
  hash.update("\0status\0");
  hash.update(status);
  hash.update("\0diff\0");
  await git(
    ["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--"],
    { hash, hashLimit: MAX_DIFF_BYTES },
  );
  const budget = { bytes: 0 };
  for (const filePath of untrackedPaths(status)) {
    await hashUntrackedFile(hash, filePath, budget);
  }
  return { head, status, fingerprint: hash.digest("hex") };
}

async function main() {
  // Porcelain paths are relative to the repository root, but the process may
  // have been started anywhere inside the worktree. Anchor there before any
  // untracked file is opened by one of those relative paths.
  const top = (await git(["rev-parse", "--show-toplevel"], { captureLimit: 4096 }))
    .toString("utf8").trim();
  if (top) {
    try {
      process.chdir(top);
    } catch {
      throw coded("read-failed");
    }
  }
  const first = await capture();
  const second = await capture();
  if (
    first.head !== second.head
    || first.fingerprint !== second.fingerprint
    || !first.status.equals(second.status)
  ) {
    throw coded("unstable");
  }
  const envelope = { head: second.head, status: second.status.toString("base64") };
  if (second.fingerprint) envelope.fingerprint = second.fingerprint;
  process.stdout.write(JSON.stringify(envelope));
}

const CODES = [
  "git-missing", "git-failed", "too-large",
  "unstable", "malformed-status", "read-failed",
];

main().catch((error) => {
  const code = error && CODES.includes(error.probeCode) ? error.probeCode : "unknown";
  process.stderr.write("review-worktree-probe:" + code + "\n");
  process.exitCode = 1;
});
`;

/**
 * The closed vocabulary the probe may report. It is deliberately free of
 * repository text so a reason can be shown to an operator, and closed so a
 * crafted filename cannot smuggle prose out through the failure path.
 */
export const REVIEW_WORKTREE_PROBE_REASON_CODES = [
  "git-missing",
  "git-failed",
  "too-large",
  "unstable",
  "malformed-status",
  "read-failed",
  "unknown",
] as const;

export type ReviewWorktreeProbeReasonCode = (typeof REVIEW_WORKTREE_PROBE_REASON_CODES)[number];

const REASON_CODE_PATTERN = /review-worktree-probe:([a-z-]{1,24})/;

/**
 * Recovers the probe's own reason code from a failed command. The script's
 * stderr is the only text trusted here, and only when it names a known code.
 */
export function reviewWorktreeProbeReasonCode(
  message: string,
): ReviewWorktreeProbeReasonCode | null {
  const matched = REASON_CODE_PATTERN.exec(message)?.[1];
  return matched && (REVIEW_WORKTREE_PROBE_REASON_CODES as readonly string[]).includes(matched)
    ? (matched as ReviewWorktreeProbeReasonCode)
    : null;
}

export interface ReviewWorktreeFingerprintResult {
  head: string;
  status: string;
  /** Only present when the caller asked for content hashing. */
  fingerprint?: string;
}

const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_ENCODED_STATUS_BYTES = Math.ceil((16 * 1024 * 1024) / 3) * 4 + 4;

/** Validates the small JSON envelope emitted by the environment-side script. */
export function parseReviewWorktreeFingerprint(raw: string): ReviewWorktreeFingerprintResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The review worktree fingerprint was malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The review worktree fingerprint was malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["head", "status", "fingerprint"].includes(key)) ||
    typeof record.head !== "string" ||
    !SHA_PATTERN.test(record.head) ||
    typeof record.status !== "string" ||
    record.status.length > MAX_ENCODED_STATUS_BYTES ||
    !BASE64_PATTERN.test(record.status) ||
    (record.fingerprint !== undefined &&
      (typeof record.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(record.fingerprint)))
  ) {
    throw new Error("The review worktree fingerprint was malformed");
  }
  return {
    head: record.head,
    status: Buffer.from(record.status, "base64").toString("utf8"),
    ...(record.fingerprint === undefined ? {} : { fingerprint: record.fingerprint as string }),
  };
}
