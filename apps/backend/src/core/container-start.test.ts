import { describe, expect, test } from "bun:test";
import { parseContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import {
  bindMountRefusedError,
  collidingHostPort,
  parsePortBindings,
  parseStartInspection,
  shouldRetryPortCollision,
  startDockerContainer,
} from "./container-start.js";
import { CommandFailedError } from "./shell.js";

// Captured from Docker 29.9.1 rootless (RootlessKit 3.3.0, builtin port driver).
const ROOTLESSKIT_IN_USE =
  "Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint nifty_kalam (58b8): error while calling RootlessKit PortManager.AddPort(): listen tcp4 127.0.0.1:38917: bind: address already in use\nfailed to start containers: 6b93";
const ROOTFUL_ALLOCATED =
  "Error response from daemon: driver failed programming external connectivity on endpoint x: Bind for 127.0.0.1:5173 failed: port is already allocated";
const REMOUNT_REFUSED =
  'Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: error mounting "/tmp/ork-readiness-x/data/github-ranges.txt" to rootfs at "/etc/orkestrator-seed/github-ranges": remount-ro /etc/orkestrator-seed/github-ranges: operation not permitted';

const automaticOnly = '{"4096/tcp":[{"HostIp":"127.0.0.1","HostPort":""}]}';
const fixedAndAutomatic =
  '{"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"38917"}],"81/tcp":[{"HostIp":"127.0.0.1","HostPort":""}]}';

describe("port collision classification", () => {
  test("names the colliding port from RootlessKit and rootful Docker", () => {
    expect(collidingHostPort(ROOTLESSKIT_IN_USE)).toBe(38917);
    expect(collidingHostPort(ROOTFUL_ALLOCATED)).toBe(5173);
    expect(collidingHostPort("something else")).toBeNull();
  });

  test("reads fixed ports, ranges and automatic mappings", () => {
    expect(parsePortBindings(fixedAndAutomatic)).toEqual({
      fixed: [{ from: 38917, to: 38917 }],
      automatic: true,
    });
    expect(parsePortBindings('{"80/tcp":[{"HostPort":"8000-8010"}]}')).toEqual({
      fixed: [{ from: 8000, to: 8010 }],
      automatic: false,
    });
    expect(parsePortBindings("null")).toEqual({ fixed: [], automatic: false });
    expect(parsePortBindings("not json")).toBeNull();
  });

  test("retries only a collision on a port Docker chose", () => {
    const automatic = parsePortBindings(automaticOnly);
    const mixed = parsePortBindings(fixedAndAutomatic);
    // The colliding port is not one the user fixed.
    expect(shouldRetryPortCollision(ROOTLESSKIT_IN_USE.replace("38917", "33169"), mixed)).toBe(
      true,
    );
    expect(shouldRetryPortCollision(ROOTLESSKIT_IN_USE, automatic)).toBe(true);
    // The user's own fixed port is theirs to free.
    expect(shouldRetryPortCollision(ROOTLESSKIT_IN_USE, mixed)).toBe(false);
    // Unnamed port: only when nothing is fixed.
    expect(shouldRetryPortCollision("address already in use", automatic)).toBe(true);
    expect(shouldRetryPortCollision("address already in use", mixed)).toBe(false);
    // Nothing automatic, unreadable bindings or another error: never.
    expect(shouldRetryPortCollision(ROOTLESSKIT_IN_USE, { fixed: [], automatic: false })).toBe(
      false,
    );
    expect(shouldRetryPortCollision(ROOTLESSKIT_IN_USE, null)).toBe(false);
    expect(shouldRetryPortCollision("no such container", automatic)).toBe(false);
  });
});

describe("bind refusal classification", () => {
  test("a refused read-only remount is a typed error naming the mount", () => {
    const error = bindMountRefusedError(REMOUNT_REFUSED);
    const parsed = parseContainerLifecycleError(error);
    expect(parsed?.code).toBe("unsupported-topology");
    expect(parsed?.message).toContain(
      "/tmp/ork-readiness-x/data/github-ranges.txt at /etc/orkestrator-seed/github-ranges",
    );
    expect(parsed?.message).toContain("nosuid or nodev");
  });

  test("other failures are not reclassified", () => {
    expect(bindMountRefusedError(ROOTLESSKIT_IN_USE)).toBeNull();
    expect(bindMountRefusedError("permission denied while trying to connect")).toBeNull();
  });
});

function scriptedRun(
  results: Array<string | Error>,
  bindings: string,
  options: { network?: string; networkId?: string; reattach?: boolean } = {},
) {
  const calls: string[][] = [];
  const network = options.network ?? "ork-env-net";
  let attached = true;
  let published = false;
  const run = (async (_command: string, args: string[] = []) => {
    calls.push(args);
    if (args[0] === "inspect") {
      const networks = attached
        ? JSON.stringify({ [network]: { IPAddress: "172.19.0.2", NetworkID: options.networkId } })
        : "{}";
      return { stdout: `${bindings}\t${options.networkId ?? network}\t${networks}\n`, stderr: "" };
    }
    if (args[0] === "network" && args[1] === "connect") {
      attached = options.reattach !== false;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "stop") return { stdout: "", stderr: "" };
    const next = results.shift();
    if (next instanceof Error) {
      attached = false;
      published = false;
      throw next;
    }
    published = attached;
    return { stdout: next ?? "", stderr: "" };
  }) as unknown as NonNullable<Parameters<typeof startDockerContainer>[1]>["run"];
  return { run, calls, attached: () => attached, published: () => published };
}

describe("startDockerContainer", () => {
  test("retries once with fresh ports after an automatic port collided", async () => {
    const { run, calls } = scriptedRun(
      [new CommandFailedError(ROOTLESSKIT_IN_USE.replace("38917", "33169")), "abc"],
      fixedAndAutomatic,
    );
    const logs: string[] = [];
    await startDockerContainer("abc123", { run, log: (line) => logs.push(line) });
    // Docker detached it from its network on the failed start: reconnected
    // before the retry, and checked after it.
    expect(calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "start abc123",
      "inspect --type",
      "network connect",
      "start abc123",
      "inspect --type",
    ]);
    expect(calls[2]).toEqual(["network", "connect", "ork-env-net", "abc123"]);
    expect(logs[0]).toContain("port=33169");
  });

  test("a gateway restart is retried as a start", async () => {
    const { run, calls } = scriptedRun(
      [new CommandFailedError(ROOTLESSKIT_IN_USE), ""],
      automaticOnly,
    );
    await startDockerContainer("gw", { run, verb: "restart", log: () => undefined });
    expect(calls.map((args) => args[0])).toEqual([
      "restart",
      "inspect",
      "network",
      "start",
      "inspect",
    ]);
  });

  test("a container created with a network ID keeps its reconnected endpoint and ports", async () => {
    const fixture = scriptedRun([new CommandFailedError(ROOTLESSKIT_IN_USE), "ok"], automaticOnly, {
      networkId: "a".repeat(64),
    });
    await startDockerContainer("abc", { run: fixture.run, log: () => undefined });
    expect(fixture.attached()).toBe(true);
    expect(fixture.published()).toBe(true);
    expect(fixture.calls.filter((args) => args[0] === "network")).toEqual([
      ["network", "connect", "a".repeat(64), "abc"],
    ]);
    expect(fixture.calls.some((args) => args[0] === "stop")).toBe(false);
  });

  test("a second collision, or one on a fixed port, is returned unchanged", async () => {
    const twice = scriptedRun(
      [new CommandFailedError(ROOTLESSKIT_IN_USE), new CommandFailedError(ROOTLESSKIT_IN_USE)],
      automaticOnly,
    );
    await expect(
      startDockerContainer("abc", { run: twice.run, log: () => undefined }),
    ).rejects.toThrow("address already in use");
    expect(twice.calls.filter((args) => args[0] === "start")).toHaveLength(2);

    const fixed = scriptedRun([new CommandFailedError(ROOTLESSKIT_IN_USE)], fixedAndAutomatic);
    await expect(startDockerContainer("abc", { run: fixed.run })).rejects.toThrow(
      "address already in use",
    );
    expect(fixed.calls.filter((args) => args[0] === "start")).toHaveLength(1);
  });

  for (const fixed of [false, true]) {
    test(`a later start restores ports after ${fixed ? "a fixed-port collision" : "both automatic attempts collide"}`, async () => {
      const collision = new CommandFailedError(ROOTLESSKIT_IN_USE);
      const fixture = scriptedRun(
        fixed ? [collision, "ok"] : [collision, collision, "ok"],
        fixed ? fixedAndAutomatic : automaticOnly,
      );
      await expect(
        startDockerContainer("abc", { run: fixture.run, log: () => undefined }),
      ).rejects.toBe(collision);
      expect(fixture.calls.filter((args) => args[0] === "start")).toHaveLength(fixed ? 1 : 2);
      expect(fixture.attached()).toBe(true);
      // The port is now free. Docker only publishes it with a network endpoint.
      await startDockerContainer("abc", { run: fixture.run });
      expect(fixture.attached()).toBe(true);
      expect(fixture.published()).toBe(true);
    });
  }

  test("a retried container still without its network is stopped and the collision returned", async () => {
    const { run, calls } = scriptedRun(
      [new CommandFailedError(ROOTLESSKIT_IN_USE), ""],
      automaticOnly,
      {
        reattach: false,
      },
    );
    await expect(startDockerContainer("abc", { run, log: () => undefined })).rejects.toThrow(
      "address already in use",
    );
    expect(calls.at(-1)).toEqual(["stop", "abc"]);
  });

  test("reads the created network, never a joined namespace", () => {
    expect(parseStartInspection(`${automaticOnly}\tork-net\t{}`)).toMatchObject({
      network: "ork-net",
      attached: [],
    });
    expect(parseStartInspection(`null\tdefault\t{"bridge":{}}`)).toMatchObject({
      network: "bridge",
      attached: ["bridge"],
    });
    expect(parseStartInspection(`null\tcontainer:abc\t{}`).network).toBeNull();
    expect(parseStartInspection(`null\thost\t{}`).network).toBeNull();
  });

  test("a refused bind becomes the typed error", async () => {
    const { run } = scriptedRun([new CommandFailedError(REMOUNT_REFUSED)], automaticOnly);
    const error = await startDockerContainer("abc", { run }).catch((caught: unknown) => caught);
    expect(parseContainerLifecycleError(error)?.code).toBe("unsupported-topology");
  });
});
