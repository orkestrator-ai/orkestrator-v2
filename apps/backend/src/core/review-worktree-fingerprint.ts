/**
 * Runs inside the environment so large diffs and untracked files are hashed at
 * their source instead of being copied through the backend command transport.
 * The script captures the state twice and refuses an unstable observation.
 */
export const REVIEW_WORKTREE_FINGERPRINT_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
const { constants, promises: fs } = require("node:fs");
const { createHash } = require("node:crypto");

const MAX_STATUS_BYTES = 16 * 1024 * 1024;
const MAX_DIFF_BYTES = 256 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 256 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

function git(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(message));
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      const limit = options.captureLimit ?? options.hashLimit ?? 0;
      if (limit > 0 && stdoutBytes > limit) {
        fail("git output exceeded the review snapshot limit");
        return;
      }
      if (options.hash) options.hash.update(chunk);
      if (options.captureLimit) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) fail("git error output exceeded the limit");
    });
    child.on("error", () => fail("git could not be started"));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) reject(new Error("git could not capture the review snapshot"));
      else resolve(options.captureLimit ? Buffer.concat(chunks) : Buffer.alloc(0));
    });
  });
}

function untrackedPaths(status) {
  const fields = status.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const entry = fields[index++];
    if (!entry || entry.length < 4 || entry[2] !== " ") {
      throw new Error("git returned malformed worktree status");
    }
    const state = entry.slice(0, 2);
    if (state === "??") paths.push(entry.slice(3));
    if ((state.includes("R") || state.includes("C")) && !fields[index++]) {
      throw new Error("git returned malformed renamed worktree status");
    }
  }
  return paths;
}

async function hashUntrackedFile(hash, filePath, budget) {
  hash.update("untracked\0");
  hash.update(filePath, "utf8");
  hash.update("\0");
  const stat = await fs.lstat(filePath);
  hash.update(String(stat.mode));
  hash.update("\0");
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(filePath, { encoding: "buffer" });
    budget.bytes += target.length;
    if (budget.bytes > MAX_UNTRACKED_BYTES) {
      throw new Error("untracked content exceeded the review snapshot limit");
    }
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
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("untracked path changed while it was read");
    hash.update("file\0");
    hash.update(String(opened.size));
    hash.update("\0");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      budget.bytes += chunk.length;
      if (budget.bytes > MAX_UNTRACKED_BYTES) {
        stream.destroy();
        throw new Error("untracked content exceeded the review snapshot limit");
      }
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
}

async function capture() {
  const head = (await git(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { captureLimit: 1024 },
  )).toString("utf8").trim();
  const status = await git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { captureLimit: MAX_STATUS_BYTES },
  );
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
  const first = await capture();
  const second = await capture();
  if (
    first.head !== second.head
    || first.fingerprint !== second.fingerprint
    || !first.status.equals(second.status)
  ) {
    throw new Error("the review worktree changed while it was captured");
  }
  process.stdout.write(JSON.stringify({
    head: second.head,
    status: second.status.toString("base64"),
    fingerprint: second.fingerprint,
  }));
}

main().catch(() => {
  process.stderr.write("review worktree fingerprint unavailable\n");
  process.exitCode = 1;
});
`;

export interface ReviewWorktreeFingerprintResult {
  head: string;
  status: string;
  fingerprint: string;
}

const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_ENCODED_STATUS_BYTES = Math.ceil((16 * 1024 * 1024) / 3) * 4 + 4;

/** Validates the small JSON envelope emitted by the environment-side script. */
export function parseReviewWorktreeFingerprint(
  raw: string,
): ReviewWorktreeFingerprintResult {
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
    Object.keys(record).some((key) => !["head", "status", "fingerprint"].includes(key))
    || typeof record.head !== "string"
    || !SHA_PATTERN.test(record.head)
    || typeof record.status !== "string"
    || record.status.length > MAX_ENCODED_STATUS_BYTES
    || !BASE64_PATTERN.test(record.status)
    || typeof record.fingerprint !== "string"
    || !FINGERPRINT_PATTERN.test(record.fingerprint)
  ) {
    throw new Error("The review worktree fingerprint was malformed");
  }
  return {
    head: record.head,
    status: Buffer.from(record.status, "base64").toString("utf8"),
    fingerprint: record.fingerprint,
  };
}
