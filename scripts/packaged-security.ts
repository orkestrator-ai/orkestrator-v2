/**
 * Reads the Electron fuses and asar layout of a locally built shipping
 * package (`electron-builder --dir`, never `release/packaged-test/`) and
 * checks them against what security report L3 requires. Used by
 * `scripts/verify-packaged-security.ts` and the shipping security spec
 * (`e2e/agent-testing/packaged-security-electron.spec.ts`).
 *
 * Node APIs only: Playwright loads this from the spec as well as Bun from the
 * CLI.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Electron's fuse sentinel; the wire follows it (`@electron/fuses`). */
export const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";

/** Positions in a version 1 fuse wire, in `@electron/fuses`'s `FuseV1Options` order. */
export const FUSE_V1_NAMES = [
  "runAsNode",
  "enableCookieEncryption",
  "enableNodeOptionsEnvironmentVariable",
  "enableNodeCliInspectArguments",
  "enableEmbeddedAsarIntegrityValidation",
  "onlyLoadAppFromAsar",
  "loadBrowserProcessSpecificV8Snapshot",
  "grantFileProtocolExtraPrivileges",
] as const;

export type FuseName = (typeof FUSE_V1_NAMES)[number];
export type FuseState = "enabled" | "disabled" | "removed" | "unknown";

/** The fuses a shipped app must have (package.json `build.electronFuses`). */
export const SHIPPED_FUSE_STATES: Partial<Record<FuseName, "enabled" | "disabled">> = {
  runAsNode: "disabled",
  enableNodeOptionsEnvironmentVariable: "disabled",
  enableNodeCliInspectArguments: "disabled",
  enableEmbeddedAsarIntegrityValidation: "enabled",
  onlyLoadAppFromAsar: "enabled",
};

export interface FuseWire {
  version: number;
  states: Partial<Record<FuseName, FuseState>>;
  /** More than one wire means a universal binary; every slice must agree. */
  wires: number;
}

function stateOf(byte: number | undefined): FuseState {
  if (byte === 0x30) return "disabled";
  if (byte === 0x31) return "enabled";
  if (byte === 0x72) return "removed";
  return "unknown";
}

/** Parses every fuse wire in an Electron binary. Throws when there is none. */
export function readFuseWire(binary: Uint8Array): FuseWire {
  const bytes = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
  const sentinel = Buffer.from(FUSE_SENTINEL, "latin1");
  const wires: FuseWire[] = [];
  for (let at = bytes.indexOf(sentinel); at !== -1; at = bytes.indexOf(sentinel, at + 1)) {
    const position = at + sentinel.length;
    const version = bytes[position];
    const length = bytes[position + 1];
    if (version === undefined || length === undefined) continue;
    const states: Partial<Record<FuseName, FuseState>> = {};
    for (let index = 0; index < length && index < FUSE_V1_NAMES.length; index++) {
      states[FUSE_V1_NAMES[index]!] = stateOf(bytes[position + 2 + index]);
    }
    wires.push({ version, states, wires: 1 });
  }
  if (wires.length === 0) throw new Error("No Electron fuse wire was found in the binary");
  const [first] = wires;
  for (const wire of wires.slice(1)) {
    if (JSON.stringify(wire.states) !== JSON.stringify(first!.states)) {
      throw new Error("The fuse wires of a universal binary disagree");
    }
  }
  return { ...first!, wires: wires.length };
}

export type ShippingPlatform = "darwin" | "linux";

export interface ShippingPackage {
  platform: ShippingPlatform;
  /** The executable a user launches. */
  executable: string;
  /** The binary holding the fuse wire (the Electron Framework on macOS). */
  fuseBinary: string;
  /** The packaged `resources` directory (app.asar, web/, backend/). */
  resources: string;
  /** macOS only: the bundle's Info.plist, which carries the asar integrity hash. */
  infoPlist?: string;
}

/**
 * The shipping `--dir` package electron-builder writes under `release/`
 * (`build.directories.output`) for this platform and architecture.
 * `release/packaged-test/` is deliberately not a candidate: that build has
 * the inspect fuse back on.
 */
export function shippingPackage(
  repositoryRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  executableOverride?: string,
): ShippingPackage {
  if (platform === "darwin") {
    const executable = executableOverride
      ? path.resolve(repositoryRoot, executableOverride)
      : path.join(
          repositoryRoot,
          `release/mac${arch === "arm64" ? "-arm64" : ""}/OrkestratorV2.app/Contents/MacOS/OrkestratorV2`,
        );
    const contents = path.resolve(path.dirname(executable), "..");
    return {
      platform,
      executable,
      fuseBinary: path.join(contents, "Frameworks/Electron Framework.framework/Electron Framework"),
      resources: path.join(contents, "Resources"),
      infoPlist: path.join(contents, "Info.plist"),
    };
  }
  if (platform === "linux") {
    const executable = executableOverride
      ? path.resolve(repositoryRoot, executableOverride)
      : path.join(
          repositoryRoot,
          `release/linux${arch === "x64" ? "" : `-${arch}`}-unpacked/orkestrator-v2`,
        );
    return {
      platform,
      executable,
      fuseBinary: executable,
      resources: path.join(path.dirname(executable), "resources"),
    };
  }
  throw new Error(`No shipping package layout for ${platform}`);
}

export interface SecurityCheck {
  check: string;
  passed: boolean;
  /** Content-free detail: fuse states and file names only. */
  detail: string;
}

export interface PackagedSecurityReport {
  platform: ShippingPlatform;
  fuseWireVersion: number;
  fuseWires: number;
  fuses: Partial<Record<FuseName, FuseState>>;
  checks: SecurityCheck[];
  passed: boolean;
}

/**
 * Reads the package's fuses and asar layout. Fails on a missing package
 * rather than reporting nothing, so a green result always means a package
 * was read.
 */
export async function verifyShippingPackage(pkg: ShippingPackage): Promise<PackagedSecurityReport> {
  if (!existsSync(pkg.executable)) {
    throw new Error(
      `No shipping package at ${pkg.executable}; build it with electron-builder --dir first`,
    );
  }
  const wire = readFuseWire(await readFile(pkg.fuseBinary));
  const checks: SecurityCheck[] = [
    {
      check: "fuse wire version 1",
      passed: wire.version === 1,
      detail: `read version ${wire.version}, ${wire.wires} wire(s)`,
    },
  ];
  for (const [name, expected] of Object.entries(SHIPPED_FUSE_STATES)) {
    const actual = wire.states[name as FuseName] ?? "unknown";
    checks.push({
      check: `fuse ${name}`,
      passed: actual === expected,
      detail: `expected ${expected}, read ${actual}`,
    });
  }
  const asar = path.join(pkg.resources, "app.asar");
  const unpackedApp = path.join(pkg.resources, "app");
  checks.push({
    check: "resources/app.asar present",
    passed: existsSync(asar),
    detail: existsSync(asar) ? "present" : "missing",
  });
  checks.push({
    check: "no resources/app folder",
    passed: !existsSync(unpackedApp),
    detail: existsSync(unpackedApp) ? "present" : "absent",
  });
  if (pkg.infoPlist) {
    // electron-builder records the asar header hash here; the integrity fuse
    // validates app.asar against it at startup. Electron enforces it on macOS
    // and Windows only.
    const plist = existsSync(pkg.infoPlist) ? await readFile(pkg.infoPlist, "latin1") : "";
    const recorded =
      plist.includes("ElectronAsarIntegrity") && plist.includes("Resources/app.asar");
    checks.push({
      check: "Info.plist ElectronAsarIntegrity for Resources/app.asar",
      passed: recorded,
      detail: recorded ? "recorded" : "missing",
    });
  }
  return {
    platform: pkg.platform,
    fuseWireVersion: wire.version,
    fuseWires: wire.wires,
    fuses: wire.states,
    checks,
    passed: checks.every((check) => check.passed),
  };
}
