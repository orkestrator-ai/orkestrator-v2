import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import {
  bridgeListenerIdentity,
  bridgeListenerScanScript,
  bridgeListenerToRecord,
  judgeBridgeListener,
  parseBridgeListenerScan,
  PENDING_LISTENER_RECORD,
  stopBridgeListenerScript,
  writeBridgeListenerRecordCommand,
  type BridgeListenerScan,
} from "../src/core/container-bridge-listener";
import { runCommand } from "../src/core/shell";

setDefaultTimeout(30_000);

/** One `ss -Hltne` line, as the scan prefixes it. */
function socketLine(inode: string, cookie: string, address = "0.0.0.0:4101"): string {
  return `listener-socket LISTEN 0      512    ${address} 0.0.0.0:* uid:1000 ino:${inode} sk:${cookie} cgroup:/ <->`;
}

function scan(lines: string[]): BridgeListenerScan {
  return parseBridgeListenerScan(lines.join("\n"));
}

describe("parseBridgeListenerScan", () => {
  test("reads the record, each socket's inode and cookie, and whether the scan finished", () => {
    const parsed = scan([
      "okb_token-line-the-credential-read-prints-first",
      "listener-record 200199803:143e",
      socketLine("200199803", "143e"),
      "listener-launch-alive",
      "listener-scan-complete",
    ]);
    expect(parsed).toEqual({
      complete: true,
      record: "200199803:143e",
      sockets: [{ inode: "200199803", cookie: "143e", uid: 1000 }],
      launchSessionAlive: true,
    });
  });

  test("an output that never finished is incomplete, and no record line is no record", () => {
    expect(scan([socketLine("1", "2")])).toMatchObject({ complete: false, record: null });
  });
});

describe("judgeBridgeListener", () => {
  const recorded = (record: string | null, ...sockets: string[]) =>
    judgeBridgeListener(
      scan([
        ...(record === null ? [] : [`listener-record ${record}`]),
        ...sockets,
        "listener-scan-complete",
      ]),
    );

  test("the recorded socket is trusted", () => {
    expect(recorded("7:a1", socketLine("7", "a1"))).toEqual({ kind: "trusted" });
  });

  test("an empty port has nothing to protect", () => {
    expect(recorded("7:a1")).toEqual({ kind: "idle" });
  });

  test("a replacement on the port is refused, even one reusing the inode number", () => {
    expect(recorded("7:a1", socketLine("8", "b2"))).toEqual({
      kind: "refused",
      reason: "different-socket",
    });
    expect(recorded("7:a1", socketLine("7", "b2"))).toEqual({
      kind: "refused",
      reason: "different-socket",
    });
  });

  test("a second socket beside the bridge's (SO_REUSEPORT, a v6 listener) is refused", () => {
    expect(recorded("7:a1", socketLine("7", "a1"), socketLine("9", "c3", "[::]:4101"))).toEqual({
      kind: "refused",
      reason: "several-sockets",
    });
  });

  test("a start that has not recorded its bridge vouches for no socket", () => {
    expect(recorded(PENDING_LISTENER_RECORD, socketLine("7", "a1"))).toEqual({
      kind: "refused",
      reason: "pending",
    });
  });

  test("a bridge from before records is adopted as it stands", () => {
    expect(recorded(null, socketLine("7", "a1"))).toEqual({
      kind: "unrecorded",
      identity: "7:a1",
    });
  });

  test("a scan that did not finish, or a socket it could not identify, is refused", () => {
    expect(judgeBridgeListener(scan([socketLine("7", "a1")]))).toEqual({
      kind: "refused",
      reason: "scan-incomplete",
    });
    expect(
      recorded("7:a1", "listener-socket LISTEN 0 512 0.0.0.0:4101 0.0.0.0:* uid:1000"),
    ).toEqual({ kind: "refused", reason: "scan-incomplete" });
  });
});

describe("bridgeListenerToRecord", () => {
  test("records the one socket, while the launch's bun is alive when there is a session", () => {
    const alive = scan([socketLine("7", "a1"), "listener-launch-alive", "listener-scan-complete"]);
    expect(bridgeListenerToRecord(alive, 42)).toEqual({ identity: "7:a1" });
    const exited = scan([socketLine("7", "a1"), "listener-scan-complete"]);
    // The launched bridge died and something else holds the port.
    expect(bridgeListenerToRecord(exited, 42)).toEqual({ refused: "launch-exited" });
    // An older launcher reports no session.
    expect(bridgeListenerToRecord(exited)).toEqual({ identity: "7:a1" });
  });

  test("refuses an empty port, several sockets and an unfinished scan", () => {
    expect(bridgeListenerToRecord(scan(["listener-scan-complete"]))).toEqual({
      refused: "no-listener",
    });
    expect(
      bridgeListenerToRecord(
        scan([socketLine("7", "a1"), socketLine("8", "b2"), "listener-scan-complete"]),
      ),
    ).toEqual({ refused: "several-sockets" });
    expect(bridgeListenerToRecord(scan([socketLine("7", "a1")]))).toEqual({
      refused: "scan-incomplete",
    });
  });
});

describe("the scripts", () => {
  test("a record is a socket identity or pending, written by rename", () => {
    expect(writeBridgeListenerRecordCommand("/run/x/pi-listener", "7:a1")).toBe(
      `record_tmp=$(mktemp '/run/x/pi-listener'.XXXXXX) && printf '%s\\n' '7:a1' > "$record_tmp" && mv "$record_tmp" '/run/x/pi-listener'`,
    );
    expect(() =>
      writeBridgeListenerRecordCommand("/run/x/pi-listener", "7:a1'; rm -rf /"),
    ).toThrow();
    expect(() => writeBridgeListenerRecordCommand("/run/x/$(id)", "7:a1")).toThrow();
  });

  test("the session check is in the scan only when a session was reported", () => {
    expect(bridgeListenerScanScript(4101, "/run/x/pi-listener")).not.toContain("/proc/");
    expect(bridgeListenerScanScript(4101, "/run/x/pi-listener", 1234)).toContain("-v session=1234");
    expect(() => bridgeListenerScanScript(4101, "/run/x/pi-listener", 1)).toThrow();
    expect(() => bridgeListenerScanScript(70_000, "/run/x/pi-listener")).toThrow();
  });
});

/**
 * The scripts themselves, against a real socket on this host: Linux with
 * `ss`, as every image has. A child of this test listens; nothing else is touched.
 */
const linuxWithSs =
  process.platform === "linux" &&
  (await runCommand("sh", ["-c", "command -v ss"], { timeoutMs: 5_000 }).then(
    () => true,
    () => false,
  ));
const onLinux = linuxWithSs ? test : test.skip;

const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A `bun` child listening on a free port, in a session of its own. */
async function listeningChild(): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") }); console.log(s.port);',
    ],
    { stdio: ["ignore", "pipe", "inherit"], detached: true },
  );
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout!.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim())));
    child.once("exit", () => reject(new Error("the listener exited")));
  });
  return { child, port };
}

async function sh(script: string): Promise<string> {
  return (await runCommand("sh", ["-c", script], { timeoutMs: 20_000 })).stdout;
}

onLinux("the scan finds the child's socket, its record and its launch session", async () => {
  const { child, port } = await listeningChild();
  const directory = await mkdtemp(path.join(os.tmpdir(), "ork-listener-"));
  directories.push(directory);
  const record = path.join(directory, "pi-listener");

  const first = parseBridgeListenerScan(await sh(bridgeListenerScanScript(port, record)));
  expect(first.complete).toBe(true);
  expect(first.record).toBeNull();
  expect(first.sockets).toHaveLength(1);
  expect(first.sockets[0]!.inode).toMatch(/^\d+$/);
  expect(first.sockets[0]!.cookie).toMatch(/^[0-9a-f]+$/);
  const identity = bridgeListenerIdentity(first.sockets[0]!);

  await sh(writeBridgeListenerRecordCommand(record, identity));
  expect((await readFile(record, "utf8")).trim()).toBe(identity);
  // `detached` made the child a session leader: its pid is its session.
  const launched = parseBridgeListenerScan(
    await sh(bridgeListenerScanScript(port, record, child.pid!)),
  );
  expect(launched.launchSessionAlive).toBe(true);
  expect(judgeBridgeListener(launched)).toEqual({ kind: "trusted" });
  // The cookie is stable: a second read names the same socket.
  expect(bridgeListenerIdentity(launched.sockets[0]!)).toBe(identity);
  // No bun runs in a session that does not exist.
  const elsewhere = parseBridgeListenerScan(
    await sh(bridgeListenerScanScript(port, record, fakePid(1))),
  );
  expect(elsewhere.launchSessionAlive).toBe(false);
});

onLinux("a replacement on the same port is a different socket", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ork-listener-"));
  directories.push(directory);
  const record = path.join(directory, "pi-listener");
  const first = await listeningChild();
  const before = parseBridgeListenerScan(await sh(bridgeListenerScanScript(first.port, record)));
  await writeFile(record, `${bridgeListenerIdentity(before.sockets[0]!)}\n`);

  // What an agent does: stop the bridge and listen where it listened.
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const imposter = spawn(
    process.execPath,
    [
      "-e",
      `Bun.serve({ port: ${first.port}, hostname: "127.0.0.1", fetch: () => new Response("ok") }); console.log("up");`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  children.push(imposter);
  await new Promise((resolve) => imposter.stdout!.once("data", resolve));

  const after = parseBridgeListenerScan(await sh(bridgeListenerScanScript(first.port, record)));
  expect(after.sockets).toHaveLength(1);
  expect(judgeBridgeListener(after)).toEqual({ kind: "refused", reason: "different-socket" });
});

onLinux("the stop script stops a listener of this uid whatever its command line", async () => {
  const { child, port } = await listeningChild();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await sh(stopBridgeListenerScript(port));
  await exited;
  expect(child.signalCode).toBe("SIGTERM");
  // Nothing left to stop is not an error.
  await sh(stopBridgeListenerScript(port));
});

onLinux(
  "a live or stopped Bun in the launch session cannot vouch for an unrelated socket",
  async () => {
    const launched = await listeningChild();
    const imposter = await listeningChild();
    const directory = await mkdtemp(path.join(os.tmpdir(), "ork-unrelated-"));
    directories.push(directory);
    const record = path.join(directory, "pi-listener");
    await writeFile(record, "pending\n");
    for (const stopped of [false, true]) {
      if (stopped) launched.child.kill("SIGSTOP");
      const scanned = parseBridgeListenerScan(
        await sh(bridgeListenerScanScript(imposter.port, record, launched.child.pid!)),
      );
      expect(bridgeListenerToRecord(scanned, launched.child.pid!)).toEqual({
        refused: "launch-exited",
      });
      expect(judgeBridgeListener(scanned)).toEqual({ kind: "refused", reason: "pending" });
    }
  },
);

onLinux("a stopped socket owner is refused even though its socket remains bound", async () => {
  const launched = await listeningChild();
  launched.child.kill("SIGSTOP");
  const directory = await mkdtemp(path.join(os.tmpdir(), "ork-stopped-"));
  directories.push(directory);
  const scanned = parseBridgeListenerScan(
    await sh(
      bridgeListenerScanScript(
        launched.port,
        path.join(directory, "pi-listener"),
        launched.child.pid!,
      ),
    ),
  );
  expect(scanned.sockets).toHaveLength(1);
  expect(bridgeListenerToRecord(scanned, launched.child.pid!)).toEqual({
    refused: "launch-exited",
  });
});

onLinux("a zombie Bun retained by a stopped launcher cannot vouch for an imposter", async () => {
  const imposter = await listeningChild();
  const launcher = spawn(
    "sh",
    [
      "-c",
      '"$1" -e \'console.log(process.pid); setTimeout(() => process.kill(process.pid, "SIGKILL"), 150);\' & kill -STOP $$; wait',
      "launcher",
      process.execPath,
    ],
    { detached: true, stdio: ["ignore", "pipe", "inherit"] },
  );
  children.push(launcher);
  const pid = await new Promise<number>((resolve) => {
    launcher.stdout!.once("data", (data: Buffer) => resolve(Number(String(data).trim())));
  });
  try {
    let zombie = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      if (stat.includes(") Z ")) {
        zombie = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(zombie).toBe(true);
    const directory = await mkdtemp(path.join(os.tmpdir(), "ork-zombie-"));
    directories.push(directory);
    const record = path.join(directory, "pi-listener");
    await writeFile(record, "pending\n");
    const scanned = parseBridgeListenerScan(
      await sh(bridgeListenerScanScript(imposter.port, record, launcher.pid!)),
    );
    expect(bridgeListenerToRecord(scanned, launcher.pid!)).toEqual({ refused: "launch-exited" });
    expect(judgeBridgeListener(scanned)).toEqual({ kind: "refused", reason: "pending" });
  } finally {
    const exited = new Promise((resolve) => launcher.once("exit", resolve));
    launcher.kill("SIGCONT");
    await exited;
  }
});
