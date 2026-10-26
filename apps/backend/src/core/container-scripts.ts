/**
 * Shell and Node scripts the backend runs inside environment containers, and
 * the sentinels they print. Stateless; shared by setup, the terminal commands,
 * file reads and media streaming.
 */

/**
 * Message shown when another setup run still holds the setup lock: usually one
 * whose terminal's host process died. That run keeps going inside the
 * container, so a retry waits for it and never starts setup a second time
 * (or stops it part-way). Once it is done the script runs setup itself if the
 * earlier run failed, or reports "Workspace already set up" if it succeeded.
 */
export const CONTAINER_WORKSPACE_SETUP_WAIT_MESSAGE =
  "An earlier setup run is still running in this container (its terminal closed before it finished). Waiting for it to finish instead of starting setup a second time.";
export const CONTAINER_WORKSPACE_SETUP_COMMAND = `if command -v flock >/dev/null 2>&1; then if ! flock -n /tmp/orkestrator-workspace-setup.lock true; then printf '%s\\n' '${CONTAINER_WORKSPACE_SETUP_WAIT_MESSAGE}'; fi; flock /tmp/orkestrator-workspace-setup.lock -c '/usr/local/bin/workspace-setup.sh'; else /usr/local/bin/workspace-setup.sh; fi`;
export const CONTAINER_WORKSPACE_PREPARE_COMMAND =
  "if command -v flock >/dev/null 2>&1; then flock /tmp/orkestrator-workspace-setup.lock -c '/usr/local/bin/workspace-setup.sh --prepare-only'; else /usr/local/bin/workspace-setup.sh --prepare-only; fi";
// The preparation phase is a contract with the script baked into the container
// image (docker/Dockerfile COPYs it to /usr/local/bin), and the image tag is
// unversioned, so an upgraded backend routinely meets an older script. That
// script has no argument handling: it ignores --prepare-only and runs the whole
// setup — including repository-controlled orkestrator-ai.json commands, as root —
// and exits 0, so the commit we would then record is not a pre-setup baseline at
// all. Probe for the capability by *reading* the script before executing it: any
// probe that runs it has already done the damage it was meant to prevent.
export const CONTAINER_WORKSPACE_SETUP_CAPABILITY_MARKER =
  "ORKESTRATOR_SETUP_CAPABILITIES=prepare-only";
export const CONTAINER_WORKSPACE_PREPARE_SUPPORTED_SENTINEL = `${String.fromCharCode(0x1e)}ORKESTRATOR_PREPARE_SUPPORTED${String.fromCharCode(0x1f)}`;
export const CONTAINER_WORKSPACE_PREPARE_OK_SENTINEL = `${String.fromCharCode(0x1e)}ORKESTRATOR_PREPARE_OK${String.fromCharCode(0x1f)}`;
export const CONTAINER_INTERACTIVE_SHELL_COMMAND = [
  "source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true",
  "orkestrator_source_runtime_env 2>/dev/null || true",
  "exec zsh -l",
].join("\n");
export function withContainerRuntimeCredential(command: string): string {
  return [
    "source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true",
    "orkestrator_source_runtime_env 2>/dev/null || true",
    command,
  ].join("\n");
}
/** Renders a sentinel as a `printf` format string, so the shell cannot drift from it. */
export function shellPrintfSentinel(sentinel: string): string {
  return sentinel.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/g,
    (character) => `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`,
  );
}
export const CONTAINER_WORKSPACE_PREPARE_SUPPORT_COMMAND = `if grep -qxF '${CONTAINER_WORKSPACE_SETUP_CAPABILITY_MARKER}' /usr/local/bin/workspace-setup.sh 2>/dev/null; then printf '${shellPrintfSentinel(CONTAINER_WORKSPACE_PREPARE_SUPPORTED_SENTINEL)}'; fi`;
export const SETUP_DONE_OSC_SEQUENCE = "\u001b]9999;setup_done\u0007";
export const SETUP_FAILED_OSC_SEQUENCE = "\u001b]9999;setup_failed\u0007";
export const SETUP_DONE_PRINTF_CMD = "printf '\\033]9999;setup_done\\007'";
export const SETUP_FAILED_PRINTF_CMD = "printf '\\033]9999;setup_failed\\007'";

export function buildContainerSafeBase64Reader(testMutation?: "append" | "replace"): string {
  const afterInitialValidationForTest =
    testMutation === "append"
      ? 'fs.appendFileSync(target, "x");'
      : testMutation === "replace"
        ? 'fs.renameSync(target, target + ".old"); fs.writeFileSync(target, "replacement");'
        : "";
  return `
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(process.argv[1]);
const target = path.resolve(process.argv[2]);
const limit = Number(process.argv[3]);
const editorRead = process.argv[4] === "editor";
// "stream": the attachment validation, but raw bytes go to stdout as they are
// read (no in-memory copy); the final stability check still decides the exit
// status, so the host discards the copy on any failure.
const streamRead = process.argv[4] === "stream";
const editorLimitLabel = process.argv[5] || String(limit) + " bytes";
function writeAll(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(1, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (!error || error.code !== "EAGAIN") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
function fail(message) {
  const error = new Error(message);
  error.safeMessage = true;
  throw error;
}
function inside(rootPath, targetPath) {
  const child = path.relative(rootPath, targetPath);
  return child === "" || (child !== ".." && !child.startsWith(".." + path.sep) && !path.isAbsolute(child));
}
function main() {
  if (!inside(root, target)) fail("File is outside the container workspace");
  const canonicalRoot = fs.realpathSync(root);
  let openedTarget = target;
  if (editorRead) {
    openedTarget = fs.realpathSync(target);
    if (!inside(canonicalRoot, openedTarget)) fail("File is outside the container workspace");
  } else {
    let current = root;
    for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) fail("Symbolic-link attachments are not allowed");
    }
    if (!inside(canonicalRoot, fs.realpathSync(target))) fail("File is outside the container workspace");
  }
  const fd = fs.openSync(openedTarget, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const initial = fs.fstatSync(fd);
    const assertStablePath = (opened) => {
      const currentPath = editorRead ? openedTarget : target;
      const currentStats = fs.lstatSync(currentPath);
      if (currentStats.isSymbolicLink()) {
        fail(editorRead ? "File is not a stable regular file" : "Symbolic-link attachments are not allowed");
      }
      if (!currentStats.isFile() || !opened.isFile() || currentStats.dev !== opened.dev || currentStats.ino !== opened.ino) {
        fail(editorRead ? "File is not a stable regular file" : "Attachment is not a stable regular file");
      }
      const resolvedTarget = fs.realpathSync(target);
      if (!inside(canonicalRoot, resolvedTarget)) fail("File is outside the container workspace");
      if (editorRead && resolvedTarget !== openedTarget) {
        fail("File changed while it was being read; please try again");
      }
    };
    assertStablePath(initial);
    if (initial.size > limit) {
      fail(editorRead
        ? "File is too large to open in the editor (maximum size is " + editorLimitLabel + ")"
        : "File exceeds the attachment size limit");
    }
    ${afterInitialValidationForTest}
    const chunks = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, (limit + 1) - total));
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (streamRead) {
        if (total > limit) break;
        writeAll(chunk.subarray(0, bytesRead));
      } else chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total > limit) {
      fail(editorRead
        ? "File is too large to open in the editor (maximum size is " + editorLimitLabel + ")"
        : "File exceeds the attachment size limit");
    }
    const final = fs.fstatSync(fd);
    assertStablePath(final);
    if (!editorRead && (
      final.dev !== initial.dev
      || final.ino !== initial.ino
      || final.size !== initial.size
      || final.size !== total
      || final.mtimeMs !== initial.mtimeMs
      || final.ctimeMs !== initial.ctimeMs
    )) fail("File changed while it was being read; please try again");
    if (!streamRead) process.stdout.write(Buffer.concat(chunks, total).toString("base64"));
  } finally {
    fs.closeSync(fd);
  }
}
try {
  main();
} catch (error) {
  const message = error && error.safeMessage
    ? error.message
    : "File could not be read safely from the container workspace";
  process.stderr.write(message + "\\n");
  process.exitCode = 1;
}
`.trim();
}
export const CONTAINER_SAFE_BASE64_READER = buildContainerSafeBase64Reader();

export const CONTAINER_UNTRACKED_STATS_SCANNER = String.raw`
const fs = require("node:fs");
const limit = Number(process.argv[1]);
const maxFiles = Number(process.argv[2]);
let scanned = 0;
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks);
  let offset = 0;
  while (offset < input.length) {
    const end = input.indexOf(0, offset);
    if (end === -1) process.exit(2);
    const record = input.subarray(offset, end);
    offset = end + 1;
    if (record.length < 4 || record[0] !== 63 || record[1] !== 63 || record[2] !== 32) continue;
    const filePath = record.subarray(3);
    // Past the cap the path is still reported - the user must be able to see the
    // file - but it is not opened. The host marks the result truncated by
    // comparing the record count against the same cap.
    // Counts are "<n>", "-" (binary) or "?" (not counted). The host keeps "0"
    // for older readers and records why there is no count.
    if (scanned >= maxFiles) {
      process.stdout.write(Buffer.from("?\t"));
      process.stdout.write(filePath);
      process.stdout.write(Buffer.from([0]));
      continue;
    }
    scanned += 1;
    let count = "0";
    let fd;
    try {
      fd = fs.openSync(
        filePath,
        fs.constants.O_RDONLY
          | (fs.constants.O_NOFOLLOW || 0)
          | (fs.constants.O_NONBLOCK || 0),
      );
      const initial = fs.fstatSync(fd);
      if (!initial.isFile() || initial.size > limit) throw new Error("skip");
      if (initial.size === 0) throw new Error("empty");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      let separators = 0;
      let previousWasCarriageReturn = false;
      let lastByte = -1;
      while (true) {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > limit) throw new Error("skip");
        for (let index = 0; index < bytesRead; index += 1) {
          const byte = buffer[index];
          if (byte === 0) throw new Error("binary");
          if (byte === 13) {
            separators += 1;
            previousWasCarriageReturn = true;
          } else if (byte === 10) {
            if (!previousWasCarriageReturn) separators += 1;
            previousWasCarriageReturn = false;
          } else {
            previousWasCarriageReturn = false;
          }
          lastByte = byte;
        }
      }
      count = String(separators + (lastByte !== 13 && lastByte !== 10 ? 1 : 0));
    } catch (error) {
      count = error && error.message === "binary" ? "-" : error && error.message === "empty" ? "0" : "?";
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }
    process.stdout.write(Buffer.from(count + "\t"));
    process.stdout.write(filePath);
    process.stdout.write(Buffer.from([0]));
  }
});
`;
