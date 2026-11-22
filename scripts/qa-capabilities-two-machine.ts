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
 * - The command node runs from a Git archive on this machine
 *   (`two-node/harness.ts`: temporary data directory, HOME and loopback port,
 *   constructed environment, `agent-test` runtime with no toolchain and no
 *   credentials).
 * - The leaf is a backend of the same commit on `--host` (an SSH host): the
 *   same archive is copied there into a new `/tmp` directory,
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
 * reconnect converging to the latest revision; handover of command to the
 * leaf with the capability state and epoch 2, after which the old command
 * node refuses fleet changes and the leaf refuses the old controller. The
 * skill files are read on the remote over SSH, independently of the link.
 *
 *   bun scripts/qa-capabilities-two-machine.ts --host <ssh-host> [--report <file>] [--keep]
 *
 * Exits 0 when checks and cleanup pass, 1 for a failed check or cleanup,
 * 2 on a setup error, and 128 + signal number on interruption.
 * Only the processes it started are signalled: the local backend and the
 * forward through their handles, and remote workers by their recorded
 * session leader, start time and run-specific command line.
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CapabilityLibrary } from "@orkestrator/protocol/capability-resources-api";

import {
  backendEnvironment,
  FORBIDDEN_PORTS,
  PeerNode,
  ROOT,
  SetupError,
  freePort,
  makeNode,
  until,
} from "./two-node/harness.ts";

import {
  forwardRefusesConnections,
  openTunnel,
  RemoteCapabilityRun,
  remotePortScript,
  runOwned,
  skillCopiesScript,
  sleep,
  waitForTunnel,
} from "./two-node/capability-remote.ts";
import {
  copiesMatchRevision,
  hasHandedOverPackage,
  runCapabilityQualification,
} from "./two-node/capability-qualification.ts";

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
if (!host || !/^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/.test(host)) {
  console.error("usage: bun scripts/qa-capabilities-two-machine.ts --host <ssh-host>");
  process.exit(2);
}

const checks: Check[] = [];
function check(name: string, passed: boolean, detail?: string) {
  checks.push({ name, passed, ...(detail ? { detail } : {}) });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

let local: PeerNode | null = null;
let tunnel: ReturnType<typeof openTunnel> | null = null;
let localRoot: string | null = null;
const remote = new RemoteCapabilityRun(host);
const facts: Record<string, unknown> = { host, remoteRoot: remote.root, keep };

async function closeTunnel(): Promise<void> {
  await tunnel?.stop();
  tunnel = null;
}

/** Read the leaf's files independently of the forward. A missing home has no copies. */
async function remoteSkillCopies(name: string, signal: AbortSignal): Promise<string[]> {
  const out = await remote.run(skillCopiesScript(name), 20_000, signal);
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

async function qualify(signal: AbortSignal): Promise<boolean> {
  const commit = (
    await runOwned("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: ROOT,
      signal,
    })
  )
    .toString()
    .trim();
  facts.commit = commit;
  // Use the same bytes for both backends, even if HEAD or the checkout changes.
  const archive = await runOwned("git", ["archive", "--format=tar.gz", commit], {
    cwd: ROOT,
    maxBytes: 1 << 30,
    signal,
  });
  localRoot = await mkdtemp(path.join(os.tmpdir(), "ork-capabilities-2m-"));
  facts.localRoot = localRoot;
  const source = path.join(localRoot, "src");
  const home = path.join(localRoot, "home");
  const tmp = path.join(localRoot, "tmp");
  for (const directory of [source, home, tmp]) await mkdir(directory, { mode: 0o700 });
  await runOwned("tar", ["-xz", "-C", source], { input: archive, signal });

  await remote.allocate(signal);
  await remote.upload('mkdir -- "$R/src" && tar -xz -C "$R/src"', archive, signal);
  const installStarted = Date.now();
  await remote.launch(
    "install",
    `
cd "$RUN_ROOT/src"
rc=0
version="$("$REAL_BUN" --no-env-file --version)"
printf '%s\\n' "$version" >"$RUN_ROOT/bun-version"
[[ "$version" == "1.4.4" ]] || rc=1
if [[ "$rc" == 0 ]]; then
  "$REAL_BUN" install --frozen-lockfile --ignore-scripts || rc=$?
fi
printf '%s\\n' "$rc" >"$RUN_ROOT/install.status"
exit "$rc"`,
    "20m",
    signal,
  );

  console.log("Installing dependencies for both isolated backends.");
  const localEnv = backendEnvironment(process.env, { home, tmp, token: "" });
  delete localEnv.ORKESTRATOR_GATEWAY_TOKEN;
  await runOwned(process.execPath, ["install", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: source,
    env: {
      ...localEnv,
      BUN_INSTALL_CACHE_DIR: path.join(localRoot, "bun-cache"),
      BUN_INSTALL_GLOBAL_STORE: "0",
      ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      CI: "1",
    },
    timeoutMs: 1_200_000,
    signal,
  });
  facts.remoteBun = (
    await remote.run(
      `
for _ in $(seq 1 2400); do
  if [[ -s "$R/install.status" ]]; then
    if [[ "$(cat "$R/install.status")" != 0 ]]; then tail -20 "$R/install.log" >&2; exit 1; fi
    cat "$R/bun-version"
    exit 0
  fi
  read -r PID START <"$R/install.pid"
  worker_is_ours "$PID" "$START" install || { echo "remote install exited without a status" >&2; exit 1; }
  sleep 0.5
done
exit 1`,
      1_200_000,
      signal,
    )
  ).trim();
  facts.remoteInstallSeconds = Math.round((Date.now() - installStarted) / 1000);

  const token = randomBytes(24).toString("base64url");
  const ports = (await remote.run(remotePortScript(), 20_000, signal))
    .trim()
    .split(/\s+/)
    .map(Number);
  if (
    ports.length !== 2 ||
    new Set(ports).size !== 2 ||
    ports.some(
      (port) =>
        !Number.isSafeInteger(port) || port < 1 || port > 65535 || FORBIDDEN_PORTS.has(port),
    )
  ) {
    throw new SetupError("Unexpected remote ports.");
  }
  const [remotePort, remoteControlPort] = ports as [number, number];
  // The token is streamed on stdin and exported only inside the worker.
  await remote.upload('cat >"$R/token"', token, signal);
  await remote.launch(
    "backend",
    `
export ORKESTRATOR_GATEWAY_TOKEN="$(cat "$RUN_ROOT/token")"
cd "$RUN_ROOT/src/apps/backend"
exec "$REAL_BUN" "$RUN_ROOT/src/apps/backend/src/main.ts" --data-dir "$RUN_ROOT/data" --host 127.0.0.1 \\
  --allow-non-tailscale-bind --port ${remotePort} --strict-gateway-port --control-port ${remoteControlPort} \\
  --runtime-flavor agent-test --worktree-dir "$RUN_ROOT/worktrees"
`,
    "30m",
    signal,
  );
  facts.remotePort = remotePort;

  const command = await makeNode({
    name: "Command",
    role: "command",
    root: localRoot,
    sourceRoot: source,
    signal,
  });
  local = command;
  await command.start();
  const tunnelPort = await freePort();
  tunnel = openTunnel(tunnelPort, remotePort, host!);
  const leaf = new PeerNode("Leaf", "leaf", remote.root, tunnelPort, token, source, signal);
  await waitForTunnel(
    tunnel,
    (pollSignal) =>
      until(
        "the remote backend to answer through the forward",
        async () => {
          leaf.version = await leaf.invoke<string>("get_app_version");
          leaf.id = (await leaf.invoke<{ nodeId: string }>("get_node_status")).nodeId;
          return true;
        },
        (ok) => ok,
        180_000,
        pollSignal,
      ),
    signal,
  );
  facts.versions = { command: command.version, leaf: leaf.version };
  const remoteClock = Number((await remote.run("date +%s%3N", 20_000, signal)).trim());
  facts.clockSkewMs = remoteClock - Date.now();
  facts.remoteKernel = (await remote.run("uname -sm", 20_000, signal)).trim();
  facts.localKernel = `${os.type()} ${os.arch()}`;

  const route = { id: "ssh-forward", kind: "https", enabled: true, origin: leaf.origin };
  const attached = await command.invoke<{ nodeId: string; connection: { state: string } }>(
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
    signal,
  );

  // --- Delivery. ---------------------------------------------------------------
  const first = await addSkill(command, "review", "Version one.");
  const deliveredOne = await until(
    "the remote leaf to receive version one",
    () => remoteSkillCopies("review", signal),
    (copies) => copies.some((text) => text.includes("Version one.")),
    90_000,
    signal,
  ).then(
    () => true,
    () => false,
  );
  check("a skill authored on the command node reaches the remote leaf", deliveredOne);

  // --- Offline catch-up. ------------------------------------------------------
  await closeTunnel();
  if (!(await forwardRefusesConnections(tunnelPort)))
    throw new Error("The closed SSH forward still accepts connections.");
  console.log("SSH forward closed. Waiting for the command node to see the leaf offline.");
  const offlineAt = Date.now();
  await until(
    "the command node to see the leaf offline",
    () =>
      command.invoke<{ nodes: Array<{ nodeId: string; connection: { state: string } }> }>(
        "list_nodes",
      ),
    (nodes) =>
      nodes.nodes.some((node) => node.nodeId === leafId && node.connection.state !== "connected"),
    120_000,
    signal,
  );
  const middle = await addSkill(command, "review", "Version two.", first.managedId);
  const latest = await addSkill(command, "review", "Version three.", first.managedId);
  await sleep(10_000, signal);
  const whileOffline = await remoteSkillCopies("review", signal);
  check(
    "the offline leaf keeps the revision it had",
    copiesMatchRevision(whileOffline, "Version one."),
  );
  tunnel = openTunnel(tunnelPort, remotePort, host!);
  const caughtUp = await waitForTunnel(
    tunnel,
    (pollSignal) =>
      until(
        "the remote leaf to catch up",
        () => remoteSkillCopies("review", pollSignal),
        (copies) => copiesMatchRevision(copies, "Version three."),
        240_000,
        pollSignal,
      ).then(
        () => true,
        () => false,
      ),
    signal,
  );
  facts.offlineSeconds = Math.round((Date.now() - offlineAt) / 1000);
  check("the leaf converges to the latest revision after reconnect", caughtUp);
  check(
    "each revision had its own artifact",
    new Set([first.artifactDigest, middle.artifactDigest, latest.artifactDigest]).size === 3,
  );

  // --- Handover. -----------------------------------------------------------------
  const commandId = (await command.invoke<{ nodeId: string }>("get_node_status")).nodeId;
  const before = await command.invoke<CapabilityLibrary>("list_capability_packages");
  const expected = before.packages.find((pkg) => pkg.id === first.packageId);
  if (
    !expected ||
    expected.artifactDigest !== latest.artifactDigest ||
    expected.assignedSetupIds.length === 0
  ) {
    throw new Error("The command node does not list the latest revision assigned to a setup.");
  }
  await command.invoke("hand_over_command", { nodeId: leafId, includeSelf: false, entries: [] });
  const library = await until(
    "the remote leaf to hold epoch 2 and the same package revision and setup assignments",
    () => leaf.invoke<CapabilityLibrary>("list_capability_packages"),
    (state) => hasHandedOverPackage(state, expected),
    120_000,
    signal,
  ).catch(() => null);
  check(
    "the handover moves the latest package and its setup assignments to the remote machine",
    Boolean(library),
  );
  check(
    "the new authority raises the epoch to 2 with the expected capability state",
    library?.epoch === 2,
  );
  const refusedLocally = await command
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
  return checks.every((entry) => entry.passed);
}

async function cleanup() {
  const failures: string[] = [];
  for (const [label, stop] of [
    ["SSH forward", closeTunnel],
    ["local backend", () => local?.stop()],
  ] as const) {
    try {
      await stop();
    } catch (error) {
      failures.push(`${label}: ${String(error)}`);
    }
  }
  try {
    const remoteState = await remote.cleanup(keep);
    facts.remoteState = remoteState;
    facts.remoteCleaned = remoteState !== "kept";
  } catch (error) {
    facts.remoteCleaned = false;
    facts.remoteCleanupError = String(error).slice(0, 400);
    failures.push(String(error));
  }
  if (localRoot && !keep && !local?.child) {
    try {
      await rm(localRoot, { recursive: true, force: true });
    } catch (error) {
      failures.push(`${localRoot}: ${String(error)}`);
    }
  }
  if (failures.length) throw new Error(failures.join("; "));
}

const exitCode = await runCapabilityQualification(qualify, cleanup, (label, error) =>
  console.error(`${label}: ${String(error).slice(0, 650)}`),
);
const report = { facts, checks, exitCode, finishedAt: new Date().toISOString() };
const target =
  reportPath ??
  path.join(ROOT, "output", "agent-testing", "capabilities-two-machine", "report.json");
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
console.log(`report: ${target}`);
process.exitCode = exitCode;
