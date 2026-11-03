import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FUSE_SENTINEL,
  readFuseWire,
  shippingPackage,
  verifyShippingPackage,
} from "../../../scripts/packaged-security";

/** A fake binary: padding, the sentinel, version 1 and one state byte per fuse. */
function binaryWith(states: string, copies = 1): Buffer {
  const wire = Buffer.concat([
    Buffer.from(FUSE_SENTINEL, "latin1"),
    Buffer.from([1, states.length]),
    Buffer.from(states, "latin1"),
  ]);
  const parts: Buffer[] = [Buffer.alloc(64, 0xaa)];
  for (let copy = 0; copy < copies; copy++) parts.push(wire, Buffer.alloc(32, 0xbb));
  return Buffer.concat(parts);
}

// runAsNode, cookie, NODE_OPTIONS, inspect, asar integrity, asar only, snapshot, file, wasm.
const SHIPPED = "000011001";
const STOCK = "101100011";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fakeLinuxPackage(states: string, withAsar = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "packaged-security-"));
  scratch.push(root);
  const pkg = shippingPackage(root, "linux", "x64");
  await mkdir(pkg.resources, { recursive: true });
  await writeFile(pkg.executable, binaryWith(states));
  if (withAsar) await writeFile(path.join(pkg.resources, "app.asar"), "asar");
  return pkg;
}

describe("readFuseWire", () => {
  test("reads each fuse by its V1 position", () => {
    const wire = readFuseWire(binaryWith(SHIPPED));
    expect(wire.version).toBe(1);
    expect(wire.wires).toBe(1);
    expect(wire.states).toMatchObject({
      runAsNode: "disabled",
      enableNodeOptionsEnvironmentVariable: "disabled",
      enableNodeCliInspectArguments: "disabled",
      enableEmbeddedAsarIntegrityValidation: "enabled",
      onlyLoadAppFromAsar: "enabled",
    });
  });

  test("reports a removed fuse and rejects a binary with no wire", () => {
    expect(readFuseWire(binaryWith("r")).states.runAsNode).toBe("removed");
    expect(() => readFuseWire(Buffer.alloc(128))).toThrow("No Electron fuse wire");
  });

  test("requires every slice of a universal binary to agree", () => {
    expect(readFuseWire(binaryWith(SHIPPED, 2)).wires).toBe(2);
    const mixed = Buffer.concat([binaryWith(SHIPPED), binaryWith(STOCK)]);
    expect(() => readFuseWire(mixed)).toThrow("disagree");
  });
});

describe("verifyShippingPackage", () => {
  test("passes a package with the shipped fuses and an asar-only layout", async () => {
    const report = await verifyShippingPackage(await fakeLinuxPackage(SHIPPED));
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  test("fails stock Electron fuses and names each one", async () => {
    const report = await verifyShippingPackage(await fakeLinuxPackage(STOCK));
    expect(report.passed).toBe(false);
    expect(report.checks.filter((check) => !check.passed).map((check) => check.check)).toEqual([
      "fuse runAsNode",
      "fuse enableNodeOptionsEnvironmentVariable",
      "fuse enableNodeCliInspectArguments",
      "fuse enableEmbeddedAsarIntegrityValidation",
      "fuse onlyLoadAppFromAsar",
    ]);
  });

  test("fails a package that loads from an app folder instead of app.asar", async () => {
    const pkg = await fakeLinuxPackage(SHIPPED, false);
    await mkdir(path.join(pkg.resources, "app"));
    const report = await verifyShippingPackage(pkg);
    expect(report.passed).toBe(false);
    expect(report.checks.filter((check) => !check.passed).map((check) => check.check)).toEqual([
      "resources/app.asar present",
      "no resources/app folder",
    ]);
  });

  test("fails when no package was built rather than passing vacuously", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "packaged-security-"));
    scratch.push(root);
    await expect(verifyShippingPackage(shippingPackage(root, "linux", "x64"))).rejects.toThrow(
      "No shipping package",
    );
  });

  test("macOS reads the Electron Framework and requires the asar integrity record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "packaged-security-"));
    scratch.push(root);
    const pkg = shippingPackage(root, "darwin", "arm64");
    expect(path.relative(root, pkg.executable)).toBe(
      "release/mac-arm64/OrkestratorV2.app/Contents/MacOS/OrkestratorV2",
    );
    await mkdir(path.dirname(pkg.executable), { recursive: true });
    await mkdir(path.dirname(pkg.fuseBinary), { recursive: true });
    await mkdir(pkg.resources, { recursive: true });
    await writeFile(pkg.executable, "launcher");
    await writeFile(pkg.fuseBinary, binaryWith(SHIPPED));
    await writeFile(path.join(pkg.resources, "app.asar"), "asar");
    await writeFile(pkg.infoPlist!, "<plist></plist>");
    expect((await verifyShippingPackage(pkg)).passed).toBe(false);
    await writeFile(
      pkg.infoPlist!,
      "<plist><key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key></dict></plist>",
    );
    expect((await verifyShippingPackage(pkg)).passed).toBe(true);
  });
});
