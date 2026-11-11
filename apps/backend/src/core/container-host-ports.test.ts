import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  backendHostPortLabelArguments,
  chooseBackendHostPorts,
  parseBackendHostPortsLabel,
  probeLoopbackPort,
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
      fixture.probe,
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
      chooseBackendHostPorts(["-p", "127.0.0.1::1/tcp", "-p", "127.0.0.1::2/tcp"], fixture.probe),
    ).rejects.toThrow("no port left");
    expect(fixture.released).toEqual([40001]);
  });

  test("the real probe returns distinct ports that are free once released", async () => {
    const { publishArguments, chosen } = await chooseBackendHostPorts(
      ["-p", "127.0.0.1::1/tcp", "-p", "127.0.0.1::2/tcp", "-p", "127.0.0.1::3/udp"],
      probeLoopbackPort,
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
