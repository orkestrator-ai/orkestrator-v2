#!/usr/bin/env bun
/**
 * Agent Capabilities across two real machines (to-do 8314 task 10;
 * docs/architecture/agent-capabilities-management.md, "Qualification").
 *
 * `apps/backend/tests/capabilities-two-node.integration.test.ts` proves the
 * same scenario with two backends in one process on loopback. This runs it
 * with the leaf on another machine: separate OS processes, filesystems and
 * clocks, and a link that crosses the network.
 *
 * - The command node is a backend of this checkout on this machine
 *   (`two-node/harness.ts`: temporary data directory, HOME and loopback port,
 *   constructed environment, `agent-test` runtime with no toolchain and no
 *   credentials).
 * - The leaf is a backend of the same commit on `--host` (an SSH host): the
 *   commit is copied there with `git archive` into a new `/tmp` directory,
 *   its backend's dependencies are installed with that directory as HOME and
 *   Bun cache (never the remote user's own), and it is started with the same
 *   flags and constructed environment as the harness, bound to the remote's
 *   loopback on a free port that is none of the production ports. Nothing on
 *   the remote outside that directory is written, and its own Orkestrator,
 *   data directory and provider homes are never read.
 * - The command node reaches the leaf through an SSH local forward this
 *   script owns. Taking the forward down is how the leaf goes offline.
 *
 * Checks: enrolment and delivery of an authored skill into the leaf's
 * capability home; the leaf offline while the setup changes, then the
 * reconnect delivering only the latest revision; handover of command to the
 * leaf with the capability state and epoch 2, after which the old command
 * node refuses fleet changes and the leaf refuses the old controller. The
 * skill files are read on the remote over SSH, independently of the link.
 *
 *   bun scripts/qa-capabilities-two-machine.ts --host <ssh-host> [--report <file>] [--keep]
 *
 * Exits 0 when every check passed, 1 when one failed, 2 on a setup error.
 * Only the processes it started are signalled: the local backend and the
 * forward through their handles, the remote backend by the PID it recorded,
 * after its command line is confirmed to name this run's directory.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FORBIDDEN_PORTS,
  PeerNode,
  ROOT,
  SetupError,
  freePort,
  makeNode,
  until,
} from "./two-node/harness.ts";

interface Check {
  name: string;
  passed: boolean;
  detail?: string;
}

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const host = option("--host");
const reportPath = option("--report");
const keep = args.includes("--keep");
if (!host || !/^[A-Za-z0-9_.@-]+$/.test(host)) {
  console.error("usage: bun scripts/qa-capabilities-two-machine.ts --host <ssh-host>");
  process.exit(2);
}

const SSH = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=12",
];

/** Run a bash script on the remote (sent on stdin, so nothing in it is an argument). */
function remote(script: string, timeoutMs = 120_000): string {
  const result = spawnSync("ssh", [...SSH, host!, "bash", "-s"], {
    input: `set -euo pipefail\n${script}\nexit 0\n`,
    timeout: timeoutMs,
    maxBuffer: 16 << 20,
  });
  if (result.status !== 0) {
    throw new SetupError(
      `remote step failed (${result.status ?? result.signal}): ${result.stderr
        .toString()
        .split("\n")
        .filter((line) => !line.startsWith("#"))
        .join(" ")
        .slice(0, 400)}`,
    );
  }
  return result.stdout.toString();
}

/** Run a remote command whose stdin is `input` (a script cannot share stdin with data). */
function remoteWithInput(command: string, input: Buffer | string, timeoutMs = 300_000): string {
  const result = spawnSync("ssh", [...SSH, host!, command], {
    input,
    timeout: timeoutMs,
    maxBuffer: 16 << 20,
  });
  if (result.status !== 0) {
    throw new SetupError(
      `remote step failed (${result.status ?? result.signal}): ${result.stderr.toString().slice(0, 400)}`,
    );
  }
  return result.stdout.toString();
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const checks: Check[] = [];
function check(name: string, passed: boolean, detail?: string) {
  checks.push({ name, passed, ...(detail ? { detail } : {}) });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

let local: PeerNode | null = null;
let tunnel: ChildProcess | null = null;
let remoteRoot: string | null = null;
let remotePid: number | null = null;
let localRoot: string | null = null;
let exitCode = 0;
const facts: Record<string, unknown> = { host };

function openTunnel(localPort: number, remotePort: number): ChildProcess {
  const child = spawn(
    "ssh",
    [
      ...SSH,
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      host!,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return child;
}

async function closeTunnel(): Promise<void> {
  const child = tunnel;
  tunnel = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

/** Every SKILL.md for `name` under the leaf's capability home, read on the remote. */
function remoteSkillCopies(name: string): string[] {
  const out = remote(
    `find ${shellQuote(`${remoteRoot}/data/capability-test-home`)} -path '*/${name}/SKILL.md' -type f -print0 2>/dev/null | xargs -0 -r -n1 sh -c 'printf "%s\\0" "$(cat "$0")"'`,
  );
  return out.split("\0").filter((entry) => entry.trim().length > 0);
}

async function addSkill(
  node: PeerNode,
  name: string,
  content: string,
  managedId?: string,
): Promise<{ packageId: string; artifactDigest: string; managedId?: string }> {
  const inspection = await node.invoke<{
    inspectionId: string;
    packageId: string;
    artifactDigest: string;
    source: { kind: string; managedId?: string };
  }>("author_capability_package", {
    kind: "skill",
    name,
    description: `${name} skill`,
    content,
    ...(managedId ? { managedId } : {}),
  });
  const preview = await node.invoke<{ operation: { id: string; planDigest: string } }>(
    "preview_capability_change",
    { change: { kind: "add-to-setup", inspectionId: inspection.inspectionId, required: true } },
  );
  await node.invoke("apply_capability_change", {
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  return {
    packageId: inspection.packageId,
    artifactDigest: inspection.artifactDigest,
    ...(inspection.source.managedId ? { managedId: inspection.source.managedId } : {}),
  };
}

try {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
  const dirty = spawnSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
  facts.commit = commit;
  if (dirty) facts.note = "local working tree has uncommitted changes; the leaf runs HEAD";

  // --- The leaf: this commit on the remote, in a directory of its own. ---------
  remoteRoot = remote("mktemp -d /tmp/ork-capabilities-2m-XXXXXX").trim();
  if (!/^\/tmp\/ork-capabilities-2m-[A-Za-z0-9]+$/.test(remoteRoot)) {
    throw new SetupError("unexpected remote directory");
  }
  const archive = spawnSync("git", ["archive", "--format=tar.gz", "HEAD"], {
    cwd: ROOT,
    maxBuffer: 1 << 30,
  });
  if (archive.status !== 0) throw new SetupError("git archive failed");
  remoteWithInput(
    `mkdir -p ${shellQuote(`${remoteRoot}/src`)} && tar -xz -C ${shellQuote(`${remoteRoot}/src`)}`,
    archive.stdout,
  );
  const remoteBun = "$HOME/.local/share/mise/installs/bun/1.4.4/bin/bun";
  // The user's Bun binary is only executed. HOME, the Bun cache and TMPDIR are
  // the run's own, so the user's bunfig, global store and cache are not used.
  const isolated = `export REAL_BUN="${remoteBun}"; R=${shellQuote(remoteRoot)}; mkdir -p "$R/home" "$R/tmp" "$R/bun-cache" "$R/data" "$R/worktrees"; export HOME="$R/home" TMPDIR="$R/tmp" BUN_INSTALL_CACHE_DIR="$R/bun-cache" BUN_INSTALL_GLOBAL_STORE=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 CI=1;`;
  const bunVersion = remote(`${isolated} "$REAL_BUN" --version`).trim();
  facts.remoteBun = bunVersion;
  if (bunVersion !== "1.4.4") throw new SetupError(`remote Bun is ${bunVersion}, not 1.4.4`);
  const installStarted = Date.now();
  remote(
    `${isolated} cd "$R/src" && "$REAL_BUN" install --frozen-lockfile --ignore-scripts >"$R/install.log" 2>&1 || { tail -20 "$R/install.log" >&2; exit 1; }`,
    1_200_000,
  );
  facts.remoteInstallSeconds = Math.round((Date.now() - installStarted) / 1000);

  const token = randomBytes(24).toString("base64url");
  const pick = `"$REAL_BUN" -e 'const forbidden=new Set([${[...FORBIDDEN_PORTS].join(",")}]);const net=require("net");async function one(){return await new Promise(r=>{const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>r(p))})})}const out=[];while(out.length<2){const p=await one();if(!forbidden.has(p)&&!out.includes(p))out.push(p)}console.log(out.join(" "))'`;
  const [remotePort, remoteControlPort] = remote(`${isolated} ${pick}`)
    .trim()
    .split(" ")
    .map(Number);
  if (!remotePort || !remoteControlPort) throw new SetupError("no remote port");
  // The token arrives on stdin and is written owner-only; it is never an argument.
  remoteWithInput(`umask 077 && cat > ${shellQuote(`${remoteRoot}/token`)}`, token, 30_000);
  const started = remote(
    `${isolated}
cd "$R/src/apps/backend"
GATEWAY_TOKEN="$(cat "$R/token")"
env -i PATH="$(dirname "$REAL_BUN"):/usr/bin:/bin:/usr/sbin:/sbin" HOME="$R/home" TMPDIR="$R/tmp" \\
  XDG_CONFIG_HOME="$R/home/.config" XDG_DATA_HOME="$R/home/.local/share" XDG_CACHE_HOME="$R/home/.cache" \\
  LANG="\${LANG:-C.UTF-8}" GIT_CONFIG_NOSYSTEM=1 ORKESTRATOR_HOST_REACHABILITY_CHECK=off \\
  ORKESTRATOR_GATEWAY_TOKEN="$GATEWAY_TOKEN" \\
  setsid "$REAL_BUN" "$R/src/apps/backend/src/main.ts" --data-dir "$R/data" --host 127.0.0.1 \\
    --allow-non-tailscale-bind --port ${remotePort} --strict-gateway-port --control-port ${remoteControlPort} \\
    --runtime-flavor agent-test --worktree-dir "$R/worktrees" \\
    </dev/null >"$R/backend.log" 2>&1 &
echo $! > "$R/backend.pid"
cat "$R/backend.pid"`,
  );
  remotePid = Number(started.trim());
  if (!Number.isSafeInteger(remotePid) || remotePid <= 1) throw new SetupError("no remote PID");
  facts.remotePort = remotePort;
  // Until the remote gateway accepts connections; a backend that exits says why.
  remote(
    `R=${shellQuote(remoteRoot)}
for _ in $(seq 1 240); do
  if [ ! -d "/proc/${remotePid}" ]; then grep -iE "error" "$R/backend.log" | head -3 >&2; exit 1; fi
  if (exec 3<>/dev/tcp/127.0.0.1/${remotePort}) 2>/dev/null; then exit 0; fi
  sleep 0.5
done
echo "remote backend did not listen" >&2; exit 1`,
    180_000,
  );

  // --- The command node here, and the link through the forward. ---------------
  localRoot = await mkdtemp(path.join(os.tmpdir(), "ork-capabilities-2m-"));
  local = await makeNode({ name: "Command", role: "command", root: localRoot });
  await local.start();
  const tunnelPort = await freePort();
  tunnel = openTunnel(tunnelPort, remotePort);
  const leaf = new PeerNode("Leaf", "leaf", remoteRoot, tunnelPort, token);
  await until(
    "the remote backend to answer through the forward",
    async () => {
      leaf.version = await leaf.invoke<string>("get_app_version");
      leaf.id = (await leaf.invoke<{ nodeId: string }>("get_node_status")).nodeId;
      return true;
    },
    (ok) => ok,
    180_000,
  );
  facts.versions = { command: local.version, leaf: leaf.version };
  const remoteClock = Number(remote(`date +%s%3N`).trim());
  facts.clockSkewMs = remoteClock - Date.now();
  facts.remoteKernel = remote("uname -sm").trim();
  facts.localKernel = `${os.type()} ${os.arch()}`;

  const route = { id: "ssh-forward", kind: "https", enabled: true, origin: leaf.origin };
  const attached = await local.invoke<{ nodeId: string; connection: { state: string } }>(
    "add_node",
    { routes: [route], token, displayName: "Remote leaf" },
  );
  check(
    "the command node enrols the remote machine",
    attached.connection.state === "connected",
    attached.connection.state,
  );
  const leafId = attached.nodeId;
  await until(
    "the remote backend to be in leaf mode",
    () => leaf.invoke<{ mode: string }>("get_node_status"),
    (status) => status.mode === "leaf",
    60_000,
  );

  // --- Delivery. ---------------------------------------------------------------
  const first = await addSkill(local, "review", "Version one.");
  const deliveredOne = await until(
    "the remote leaf to receive version one",
    async () => remoteSkillCopies("review"),
    (copies) => copies.some((text) => text.includes("Version one.")),
    90_000,
  ).then(
    () => true,
    () => false,
  );
  check("a skill authored on the command node reaches the remote leaf", deliveredOne);

  // --- Offline catch-up: only the latest revision arrives. ------------------------
  await closeTunnel();
  const offlineAt = Date.now();
  await until(
    "the command node to see the leaf offline",
    () =>
      local!.invoke<{ nodes: Array<{ nodeId: string; connection: { state: string } }> }>(
        "list_nodes",
      ),
    (nodes) =>
      nodes.nodes.some((node) => node.nodeId === leafId && node.connection.state !== "connected"),
    120_000,
  ).catch(() => undefined);
  const middle = await addSkill(local, "review", "Version two.", first.managedId);
  const latest = await addSkill(local, "review", "Version three.", first.managedId);
  await Bun.sleep(10_000);
  const whileOffline = remoteSkillCopies("review");
  check(
    "the offline leaf keeps the revision it had",
    whileOffline.length > 0 && whileOffline.every((text) => text.includes("Version one.")),
  );
  tunnel = openTunnel(tunnelPort, remotePort);
  const caughtUp = await until(
    "the remote leaf to catch up",
    async () => remoteSkillCopies("review"),
    (copies) => copies.length > 0 && copies.every((text) => text.includes("Version three.")),
    240_000,
  ).then(
    () => true,
    () => false,
  );
  facts.offlineSeconds = Math.round((Date.now() - offlineAt) / 1000);
  check("the reconnect delivers the latest revision only", caughtUp);
  check(
    "each revision had its own artifact",
    new Set([first.artifactDigest, middle.artifactDigest, latest.artifactDigest]).size === 3,
  );

  // --- Handover. -----------------------------------------------------------------
  const commandId = (await local.invoke<{ nodeId: string }>("get_node_status")).nodeId;
  await local.invoke("hand_over_command", { nodeId: leafId, includeSelf: false, entries: [] });
  const library = await until(
    "the remote leaf to hold the capability authority",
    () =>
      leaf.invoke<{ epoch: number; packages: Array<{ id: string }> }>("list_capability_packages"),
    (state) => state.packages.some((pkg) => pkg.id === first.packageId),
    120_000,
  ).catch(() => null);
  check(
    "the handover moves the capability state to the remote machine",
    Boolean(library),
    library ? `epoch ${library.epoch}` : "not received",
  );
  check("the new authority raises the epoch to 2", library?.epoch === 2);
  const refusedLocally = await local
    .invoke("author_capability_package", { kind: "skill", name: "late", content: "x" })
    .then(
      () => "accepted",
      (error: unknown) => String(error),
    );
  check(
    "the old command node refuses fleet changes",
    /command node/.test(refusedLocally),
    refusedLocally.slice(0, 160),
  );
  const refusedRemotely = await leaf
    .invoke("get_capability_node_observation", { controllerId: commandId, epoch: 1 })
    .then(
      () => "accepted",
      (error: unknown) => String(error),
    );
  check(
    "the remote leaf refuses the old controller",
    /newer command node/.test(refusedRemotely),
    refusedRemotely.slice(0, 160),
  );
  facts.leafIdSuffix = leafId.slice(-6);
} catch (error) {
  exitCode = error instanceof SetupError ? 2 : 1;
  console.error(
    `${error instanceof SetupError ? "SETUP" : "ERROR"}: ${String(error).slice(0, 500)}`,
  );
} finally {
  await closeTunnel().catch(() => undefined);
  await local?.stop().catch(() => undefined);
  if (remoteRoot) {
    try {
      // Signal only the PID this run recorded, and only while its command line names this run.
      remote(
        `R=${shellQuote(remoteRoot)}
if [ -f "$R/backend.pid" ]; then
  PID="$(cat "$R/backend.pid")"
  if [ -r "/proc/$PID/cmdline" ] && tr '\\0' ' ' <"/proc/$PID/cmdline" | grep -qF "$R/src/apps/backend/src/main.ts"; then
    kill -TERM "$PID" || true
    for _ in $(seq 1 30); do [ -d "/proc/$PID" ] || break; sleep 0.5; done
    if [ -d "/proc/$PID" ] && tr '\\0' ' ' <"/proc/$PID/cmdline" | grep -qF "$R/src/apps/backend/src/main.ts"; then kill -KILL "$PID" || true; fi
  fi
fi
${keep ? "" : `case "$R" in /tmp/ork-capabilities-2m-*) rm -rf "$R" ;; esac`}`,
      );
      facts.remoteCleaned = !keep;
    } catch (error) {
      facts.remoteCleanupError = String(error).slice(0, 300);
    }
  }
  if (localRoot && !keep) await rm(localRoot, { recursive: true, force: true });
  if (exitCode === 0 && checks.some((entry) => !entry.passed)) exitCode = 1;
  const report = { facts, checks, exitCode, finishedAt: new Date().toISOString() };
  const target =
    reportPath ??
    path.join(ROOT, "output", "agent-testing", "capabilities-two-machine", "report.json");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${target}`);
  process.exit(exitCode);
}
