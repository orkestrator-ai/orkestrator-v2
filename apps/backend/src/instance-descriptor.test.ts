import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BACKEND_INSTANCE_DESCRIPTOR_TYPE,
  parseBackendInstanceDescriptor,
  type BackendInstanceEndpoint,
} from "@orkestrator/protocol/backend-instance";
import {
  instanceDescriptorPath,
  instanceEndpoints,
  publishInstanceDescriptor,
} from "./instance-descriptor.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const base = {
  version: 1,
  type: BACKEND_INSTANCE_DESCRIPTOR_TYPE,
  installationId: "bk_test",
  generation: "generation-1",
  pid: 1234,
  startedAt: "2026-10-21T00:00:00.000Z",
  url: "http://127.0.0.1:40001/",
  authFile: "/data/gateway-auth.json",
  dataDir: "/data",
  appVersion: "9.9.9",
  publicApiSchemaVersion: 1,
};

describe("instance descriptor endpoints", () => {
  test("stays backward compatible when endpoints are absent", () => {
    const parsed = parseBackendInstanceDescriptor(base);
    expect(parsed.endpoints).toBeUndefined();
    expect("endpoints" in parsed).toBe(false);
  });

  test("accepts bounded control and client endpoints", () => {
    const endpoints: BackendInstanceEndpoint[] = [
      { role: "control", url: "http://127.0.0.1:40001/" },
      { role: "client", url: "http://127.0.0.1:34125/" },
      { role: "client", url: "http://[::1]:34126/" },
    ];
    expect(parseBackendInstanceDescriptor({ ...base, endpoints }).endpoints).toEqual(endpoints);
    expect(parseBackendInstanceDescriptor({ ...base, endpoints: [] }).endpoints).toEqual([]);
  });

  test("rejects malformed, unknown-role, credentialed or excessive endpoints", () => {
    const invalid: unknown[] = [
      "http://127.0.0.1:1/",
      {},
      [null],
      [{ role: "admin", url: "http://127.0.0.1:1/" }],
      [{ role: "client" }],
      [{ role: "client", url: "ftp://127.0.0.1:1/" }],
      [{ role: "client", url: "http://user:secret@127.0.0.1:1/" }],
      [{ role: "client", url: "http://127.0.0.1:1/?token=secret" }],
      [{ role: "client", url: "not a url" }],
      Array.from({ length: 9 }, (_, index) => ({
        role: "client",
        url: `http://127.0.0.1:${40_000 + index}/`,
      })),
    ];
    for (const endpoints of invalid) {
      expect(() => parseBackendInstanceDescriptor({ ...base, endpoints })).toThrow(
        "Backend instance descriptor field is invalid: endpoints",
      );
    }
  });

  test("lists the control listener, a loopback browser listener and the loopback client", () => {
    expect(
      instanceEndpoints({
        controlUrl: "http://127.0.0.1:40001/",
        browserUrl: "http://127.0.0.1:34121/",
        loopbackClientUrl: "http://127.0.0.1:34125/",
      }),
    ).toEqual([
      { role: "control", url: "http://127.0.0.1:40001/" },
      { role: "client", url: "http://127.0.0.1:34121/" },
      { role: "client", url: "http://127.0.0.1:34125/" },
    ]);
    // A Tailscale browser listener is not a loopback client endpoint.
    expect(
      instanceEndpoints({
        controlUrl: "http://127.0.0.1:40001/",
        browserUrl: "http://100.88.12.3:34121/",
      }),
    ).toEqual([{ role: "control", url: "http://127.0.0.1:40001/" }]);
    expect(instanceEndpoints({})).toEqual([]);
  });

  test("publishes endpoints that the client parser reads back", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-instance-descriptor-"));
    directories.push(dataDir);
    const endpoints = instanceEndpoints({
      controlUrl: "http://127.0.0.1:40001/",
      loopbackClientUrl: "http://127.0.0.1:34125/",
    });
    const remove = await publishInstanceDescriptor({
      installationId: "bk_test",
      generation: "generation-1",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      url: "http://127.0.0.1:40001/",
      endpoints,
      authFile: path.join(dataDir, "gateway-auth.json"),
      dataDir,
      appVersion: "9.9.9",
      publicApiSchemaVersion: 1,
    });
    const stored = parseBackendInstanceDescriptor(
      JSON.parse(await fs.readFile(instanceDescriptorPath(dataDir), "utf8")),
    );
    expect(stored.endpoints).toEqual(endpoints);
    await remove();
  });
});
