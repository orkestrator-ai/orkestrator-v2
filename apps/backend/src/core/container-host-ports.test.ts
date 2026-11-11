import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  backendHostPortLabelArguments,
  chooseBackendHostPorts,
  HOST_PORT_PROBE_ATTEMPTS,
  HOST_PORT_RESERVATION_MS,
  listOwnedBackendHostPorts,
  parseBackendHostPortsLabel,
  probeLoopbackPort,
  resetBackendHostPortReservations,
  type HostPortProbe,
} from "./container-host-ports.js";
import { ingressPorts } from "./container-network.js";

function scriptedProbe(ports: number[]) {
  const released: number[] = [];
  const protocols: string[] = [];
  const probe: HostPortProbe = async (protocol) => {
    const port = ports.shift();
    if (port === undefined) throw new Error("no port left");
    protocols.push(protocol);
    return {
      port,
      release: async () => {
        released.push(port);
      },
    };
  };
  return { probe, released, protocols };
}

afterEach(() => {
  resetBackendHostPortReservations();
});

describe("chooseBackendHostPorts", () => {
  test("gives each automatic loopback mapping a chosen port and keeps the rest", async () => {
    const fixture = scriptedProbe([40001, 40003, 40005]);
    const result = await chooseBackendHostPorts(
      [
        "-p",
        "127.0.0.1:5173:5173/tcp",
        "-p",
        "127.0.0.1::3000/tcp",
        "-p",
        "127.0.0.1::5353/udp",
        "-p",
        "127.0.0.1::4097/tcp",
      ],
      { probe: fixture.probe },
    );
    expect(result.publishArguments).toEqual([
      "-p",
      "127.0.0.1:5173:5173/tcp",
      "-p",
      "127.0.0.1:40001:3000/tcp",
      "-p",
      "127.0.0.1:40003:5353/udp",
      "-p",
      "127.0.0.1:40005:4097/tcp",
    ]);
    expect(result.chosen).toEqual([40001, 40003, 40005]);
    expect(fixture.protocols).toEqual(["tcp", "udp", "tcp"]);
    // Every probe is released, only after all were chosen.
    expect(fixture.released.sort()).toEqual([40001, 40003, 40005]);
    // The firewall's ingress rule still names the container ports.
    expect(ingressPorts(result.publishArguments)).toEqual([3000, 4097, 5173]);
  });

  test("releases what it holds when a probe fails", async () => {
    const fixture = scriptedProbe([40001]);
    await expect(
      chooseBackendHostPorts(["-p", "127.0.0.1::1/tcp", "-p", "127.0.0.1::2/tcp"], {
        probe: fixture.probe,
      }),
    ).rejects.toThrow("no port left");
    expect(fixture.released).toEqual([40001]);
  });

  test("never chooses a host port the same request fixes, wherever it is listed", async () => {
    // The fixed mapping comes after the automatic one, and Docker has not
    // bound it yet, so the kernel can hand out its port.
    const fixture = scriptedProbe([40001, 40003, 40001]);
    const result = await chooseBackendHostPorts(
      ["-p", "127.0.0.1::3000/tcp", "-p", "127.0.0.1:40001:5173/tcp", "-p", "127.0.0.1::5353/udp"],
      { probe: fixture.probe },
    );
    expect(result.publishArguments).toEqual([
      "-p",
      "127.0.0.1:40003:3000/tcp",
      "-p",
      "127.0.0.1:40001:5173/tcp",
      // A fixed TCP port does not take the same UDP port.
      "-p",
      "127.0.0.1:40001:5353/udp",
    ]);
    expect(result.chosen).toEqual([40003, 40001]);
    // The refused candidate was held too, and every probe is released.
    expect(fixture.released.sort()).toEqual([40001, 40001, 40003]);
  });

  test("refuses ports other containers are labelled with, for both protocols", async () => {
    const fixture = scriptedProbe([40001, 40005, 40003, 40007]);
    const result = await chooseBackendHostPorts(
      ["-p", "127.0.0.1::1/tcp", "-p", "127.0.0.1::2/udp"],
      { probe: fixture.probe, reserved: [40001, 40003] },
    );
    expect(result.chosen).toEqual([40005, 40007]);
    expect(fixture.released.sort()).toEqual([40001, 40003, 40005, 40007]);
  });

  test("a port this process just chose is not chosen again until its reservation ends", async () => {
    let now = 1_000;
    const clock = () => now;
    const first = await chooseBackendHostPorts(["-p", "127.0.0.1::1/tcp"], {
      probe: scriptedProbe([40001]).probe,
      now: clock,
    });
    expect(first.chosen).toEqual([40001]);
    // A concurrent create: the first container does not exist yet, so the
    // kernel and Docker both report the port free.
    const second = await chooseBackendHostPorts(["-p", "127.0.0.1::1/tcp"], {
      probe: scriptedProbe([40001, 40003]).probe,
      now: clock,
    });
    expect(second.chosen).toEqual([40003]);
    now += HOST_PORT_RESERVATION_MS;
    const later = await chooseBackendHostPorts(["-p", "127.0.0.1::1/tcp"], {
      probe: scriptedProbe([40001]).probe,
      now: clock,
    });
    expect(later.chosen).toEqual([40001]);
  });

  test("gives up after a bounded number of refused candidates, releasing them all", async () => {
    const fixture = scriptedProbe(Array.from({ length: HOST_PORT_PROBE_ATTEMPTS }, () => 40001));
    await expect(
      chooseBackendHostPorts(["-p", "127.0.0.1::1/tcp"], {
        probe: fixture.probe,
        reserved: [40001],
      }),
    ).rejects.toThrow(`after ${HOST_PORT_PROBE_ATTEMPTS} tries`);
    expect(fixture.released).toHaveLength(HOST_PORT_PROBE_ATTEMPTS);
    // A failed choice reserves nothing.
    const next = await chooseBackendHostPorts(["-p", "127.0.0.1::1/tcp"], {
      probe: scriptedProbe([40003]).probe,
    });
    expect(next.chosen).toEqual([40003]);
  });

  test("the real probe returns distinct ports that are free once released", async () => {
    const { publishArguments, chosen } = await chooseBackendHostPorts(
      ["-p", "127.0.0.1::1/tcp", "-p", "127.0.0.1::2/tcp", "-p", "127.0.0.1::3/udp"],
      { probe: probeLoopbackPort },
    );
    expect(new Set(chosen).size).toBe(3);
    expect(publishArguments[1]).toBe(`127.0.0.1:${chosen[0]}:1/tcp`);
    for (const port of chosen.slice(0, 2)) {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("backend host port label", () => {
  test("round-trips and refuses malformed values", () => {
    expect(backendHostPortLabelArguments([])).toEqual([]);
    const [, label] = backendHostPortLabelArguments([40001, 40003]);
    expect(label).toBe("orkestrator-backend-host-ports=40001,40003");
    expect(parseBackendHostPortsLabel(label!.split("=")[1])).toEqual([40001, 40003]);
    expect(parseBackendHostPortsLabel(undefined)).toEqual([]);
    expect(parseBackendHostPortsLabel("<no value>")).toEqual([]);
    expect(parseBackendHostPortsLabel("40001,70000")).toEqual([]);
    expect(parseBackendHostPortsLabel("40001,,40003")).toEqual([]);
  });
});

describe("listOwnedBackendHostPorts", () => {
  test("reads the label of every owned container, running or stopped", async () => {
    const calls: string[][] = [];
    const ports = await listOwnedBackendHostPorts("owner-1", async (_command, args) => {
      calls.push(args);
      return { stdout: "40003,40001\n\n<no value>\nbad,1\n40001,40009\n" };
    });
    expect(ports).toEqual([40001, 40003, 40009]);
    expect(calls).toEqual([
      [
        "ps",
        "-a",
        "--filter",
        "label=orkestrator-owner=owner-1",
        "--filter",
        "label=orkestrator-backend-host-ports",
        "--format",
        '{{.Label "orkestrator-backend-host-ports"}}',
      ],
    ]);
  });

  test("a failed listing is an error, never an empty answer", async () => {
    await expect(
      listOwnedBackendHostPorts("owner-1", async () => {
        throw new Error("daemon unreachable");
      }),
    ).rejects.toThrow("daemon unreachable");
  });
});
