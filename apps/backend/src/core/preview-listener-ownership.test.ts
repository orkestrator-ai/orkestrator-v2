import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";

import {
  LoopbackListenerOwnership,
  parseLsofPids,
  parsePsAncestry,
  parseSsListeners,
  type ManagedProcessRoot,
} from "./preview-listener-ownership.js";
import { CommandFailedError } from "./shell.js";

const PS = [
  "  100     1 Sun Oct 25 09:00:00 2026",
  "  200   100 Sun Oct 25 09:01:00 2026",
  "  300   200 Sun Oct 25 09:02:00 2026",
  "  400     1 Sun Oct 25 09:03:00 2026",
  "  500   400 Sun Oct 25 09:04:00 2026",
  "  600     1 Sun Oct 25 09:05:00 2026",
].join("\n");

function fakeHost(options: {
  listeners?: Record<number, number[]>;
  ps?: string;
  lsofError?: Error;
  psError?: Error;
  ss?: string;
}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runCommand = async (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === "lsof") {
      if (options.lsofError) throw options.lsofError;
      const port = Number(/TCP:(\d+)/.exec(args.join(" "))?.[1]);
      const pids = options.listeners?.[port] ?? [];
      if (pids.length === 0) throw new CommandFailedError("", { exitCode: 1 });
      return { stdout: pids.map((pid) => `p${pid}\nf12\n`).join("") };
    }
    if (command === "ss") {
      if (options.ss === undefined) throw new CommandFailedError("", { executableMissing: true });
      return { stdout: options.ss };
    }
    if (options.psError) throw options.psError;
    return { stdout: options.ps ?? PS };
  };
  return { calls, runCommand };
}

function ownership(
  host: ReturnType<typeof fakeHost>,
  roots: ManagedProcessRoot[],
  platform: NodeJS.Platform = "darwin",
) {
  return new LoopbackListenerOwnership({
    roots: () => roots,
    runCommand: host.runCommand,
    platform,
    processCacheMs: 0,
  });
}

describe("listener ownership parsing", () => {
  test("reads ss listeners, including ones whose process is hidden", () => {
    expect(
      parseSsListeners(
        'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=300,fd=18),("node",pid=301,fd=18))\n',
      ),
    ).toEqual({ pids: [300, 301], anonymous: false });
    expect(parseSsListeners("LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*\n")).toEqual({
      pids: [],
      anonymous: true,
    });
    expect(parseSsListeners("")).toEqual({ pids: [], anonymous: false });
  });

  test("reads lsof process fields and ps ancestry", () => {
    expect(parseLsofPids("p12\nf4\np12\nf5\np40\n")).toEqual([12, 40]);
    const listed = parsePsAncestry(PS);
    expect(listed.get(300)).toEqual({ ppid: 200, started: "Sun Oct 25 09:02:00 2026" });
    expect(listed.size).toBe(6);
  });
});

describe("LoopbackListenerOwnership", () => {
  test("a listener under this environment's terminal is attributed to it", async () => {
    const host = fakeHost({ listeners: { 3000: [300] } });
    const result = await ownership(host, [{ environmentId: "a", pid: 100 }]).attribute(
      "a",
      3000,
      "ipv4",
    );
    expect(result.attribution).toBe("this-environment");
    // Only the registered port is looked up; never a range.
    expect(host.calls[0]).toEqual({
      command: "lsof",
      args: ["-nP", "-a", "-i4TCP:3000", "-sTCP:LISTEN", "-Fp"],
    });
  });

  test("another environment's listener is reported as such, never as this one", async () => {
    const host = fakeHost({ listeners: { 3000: [500] } });
    const result = await ownership(host, [
      { environmentId: "a", pid: 100 },
      { environmentId: "b", pid: 400 },
    ]).attribute("a", 3000, "ipv4");
    expect(result.attribution).toBe("other-environment");
  });

  test("a listener with no backend-started ancestor is unattributed", async () => {
    const host = fakeHost({ listeners: { 3000: [600] } });
    const result = await ownership(host, [{ environmentId: "a", pid: 100 }]).attribute(
      "a",
      3000,
      "ipv6",
    );
    expect(result.attribution).toBe("unattributed");
    expect(host.calls[0]!.args).toContain("-i6TCP:3000");
  });

  test("this environment sharing the port with a stranger has no single owner", async () => {
    const host = fakeHost({ listeners: { 3000: [300, 600] } });
    const result = await ownership(host, [{ environmentId: "a", pid: 100 }]).attribute(
      "a",
      3000,
      "ipv4",
    );
    expect(result.attribution).toBe("unattributed");
  });

  test("no listener is none; a missing lsof, a timeout or another platform is unchecked", async () => {
    expect((await ownership(fakeHost({}), []).attribute("a", 3000, "ipv4")).attribution).toBe(
      "none",
    );
    const missing = fakeHost({
      lsofError: new CommandFailedError("not found", { executableMissing: true }),
    });
    expect((await ownership(missing, []).attribute("a", 3000, "ipv4")).attribution).toBe(
      "unchecked",
    );
    const slow = fakeHost({ lsofError: new CommandFailedError("slow", { timedOut: true }) });
    expect((await ownership(slow, []).attribute("a", 3000, "ipv4")).attribution).toBe("unchecked");
    const psFails = fakeHost({ listeners: { 3000: [300] }, psError: new Error("ps") });
    expect((await ownership(psFails, []).attribute("a", 3000, "ipv4")).attribution).toBe(
      "unchecked",
    );
    const windows = fakeHost({ listeners: { 3000: [300] } });
    expect((await ownership(windows, [], "win32").attribute("a", 3000, "ipv4")).attribution).toBe(
      "unchecked",
    );
    expect(windows.calls).toEqual([]);
  });

  test("a Linux host without lsof falls back to ss for the one port", async () => {
    const missing = new CommandFailedError("not found", { executableMissing: true });
    const host = fakeHost({
      lsofError: missing,
      ss: 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=300,fd=18))\n',
    });
    const checker = ownership(host, [{ environmentId: "a", pid: 100 }], "linux");
    expect((await checker.attribute("a", 3000, "ipv4")).attribution).toBe("this-environment");
    expect(host.calls.find((call) => call.command === "ss")?.args).toEqual([
      "-H",
      "-ltnp",
      "-4",
      "sport = :3000",
    ]);
    const hidden = fakeHost({ lsofError: missing, ss: "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*\n" });
    expect((await ownership(hidden, [], "linux").attribute("a", 3000, "ipv4")).attribution).toBe(
      "unattributed",
    );
    const nothing = fakeHost({ lsofError: missing, ss: "" });
    expect((await ownership(nothing, [], "linux").attribute("a", 3000, "ipv4")).attribution).toBe(
      "none",
    );
    const neither = fakeHost({ lsofError: missing });
    expect((await ownership(neither, [], "linux").attribute("a", 3000, "ipv4")).attribution).toBe(
      "unchecked",
    );
  });

  test("the process key changes when the listener restarts", async () => {
    const roots = [{ environmentId: "a", pid: 100 }];
    const first = await ownership(fakeHost({ listeners: { 3000: [300] } }), roots).attribute(
      "a",
      3000,
      "ipv4",
    );
    const restarted = await ownership(
      fakeHost({
        listeners: { 3000: [300] },
        ps: PS.replace("Sun Oct 25 09:02:00 2026", "Sun Oct 25 10:30:00 2026"),
      }),
      roots,
    ).attribute("a", 3000, "ipv4");
    const again = await ownership(fakeHost({ listeners: { 3000: [300] } }), roots).attribute(
      "a",
      3000,
      "ipv4",
    );
    if (
      first.attribution !== "this-environment" ||
      restarted.attribution !== "this-environment" ||
      again.attribution !== "this-environment"
    )
      throw new Error("expected attribution");
    expect(restarted.processKey).not.toBe(first.processKey);
    expect(again.processKey).toBe(first.processKey);
  });

  test("a listener newer than the shared process listing is looked up afresh", async () => {
    const options: Parameters<typeof fakeHost>[0] = { listeners: { 3000: [300] } };
    const host = fakeHost(options);
    const checker = new LoopbackListenerOwnership({
      roots: () => [{ environmentId: "a", pid: 100 }],
      runCommand: host.runCommand,
      platform: "darwin",
      processCacheMs: 60_000,
    });
    expect((await checker.attribute("a", 3000, "ipv4")).attribution).toBe("this-environment");
    // A dev server started a moment later, after the cached listing.
    options.listeners = { 3000: [300], 3001: [700] };
    options.ps = `${PS}\n  700   100 Sun Oct 25 09:06:00 2026`;
    expect((await checker.attribute("a", 3001, "ipv4")).attribution).toBe("this-environment");
    expect(host.calls.filter((call) => call.command === "ps")).toHaveLength(2);
    // A listener already in the listing reuses it.
    await checker.attribute("a", 3000, "ipv4");
    expect(host.calls.filter((call) => call.command === "ps")).toHaveLength(2);
  });

  test("concurrent checks of one port share a lookup", async () => {
    const host = fakeHost({ listeners: { 3000: [300] } });
    const checker = ownership(host, [{ environmentId: "a", pid: 100 }]);
    await Promise.all([checker.attribute("a", 3000, "ipv4"), checker.attribute("a", 3000, "ipv4")]);
    expect(host.calls.filter((call) => call.command === "lsof")).toHaveLength(1);
  });
});

// Real lsof and ps on this host: a child process listening on a free port is
// attributed through its real parent chain.
const realHost = process.platform === "darwin" || process.platform === "linux";
describe.skipIf(!realHost)("LoopbackListenerOwnership on this host", () => {
  let child: ChildProcess | null = null;
  afterEach(() => {
    // The whole group: dash does not exec the last command, so the server can
    // be the shell's child rather than the shell itself.
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    child = null;
  });

  async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  test("attributes a real listener to the environment whose process started it", async () => {
    const port = await freePort();
    // A shell (the "terminal") starting a server, as a dev server runs in one.
    child = spawn(
      "/bin/sh",
      [
        "-c",
        `"${process.execPath}" -e 'require("node:net").createServer().listen(${port}, "127.0.0.1", () => console.log("ready"))'`,
      ],
      { detached: true, stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve, reject) => {
      child!.stdout!.once("data", () => resolve());
      child!.once("exit", (code) => reject(new Error(`listener exited ${code}`)));
    });
    const roots: ManagedProcessRoot[] = [{ environmentId: "a", pid: child.pid! }];
    const checker = new LoopbackListenerOwnership({ roots: () => roots, processCacheMs: 0 });
    const mine = await checker.attribute("a", port, "ipv4");
    // A host with neither lsof nor ss cannot run the check, and says so.
    if (!Bun.which("lsof") && !Bun.which("ss")) {
      expect(mine.attribution).toBe("unchecked");
      return;
    }
    expect(mine.attribution).toBe("this-environment");
    expect((await checker.attribute("b", port, "ipv4")).attribution).toBe("other-environment");
    roots.length = 0;
    expect((await checker.attribute("a", port, "ipv4")).attribution).toBe("unattributed");
    expect((await checker.attribute("a", await freePort(), "ipv4")).attribution).toBe("none");
  }, 20_000);
});
