import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dir, "..");
const project = path.join(root, "apps/ios/OrkestratorMobile.xcodeproj");
const derivedData = process.env.ORKESTRATOR_IOS_DERIVED_DATA
  ?? path.join(process.env.TMPDIR ?? "/tmp", "orkestrator-mobile-derived");
const developerDirectory = process.env.DEVELOPER_DIR
  ?? "/Applications/Xcode.app/Contents/Developer";
const environment = { ...process.env, DEVELOPER_DIR: developerDirectory };

interface SimulatorDevice {
  dataPath: string;
  dataPathSize: number;
  deviceTypeIdentifier: string;
  isAvailable: boolean;
  lastBootedAt?: string;
  logPath: string;
  logPathSize: number;
  name: string;
  state: "Booted" | "Shutdown" | string;
  udid: string;
}

interface SimulatorList {
  devices: Record<string, SimulatorDevice[]>;
}

function fail(message: string): never {
  console.error(`\n[iOS] ${message}`);
  process.exit(1);
}

function run(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    fail(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
  return capture ? result.stdout : "";
}

function requestedDeviceName(): string {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: bun run dev:ios [--device "iPhone 17 Pro"]

Environment variables:
  ORKESTRATOR_IOS_SIMULATOR    Default simulator device name
  ORKESTRATOR_IOS_DERIVED_DATA Build output directory
  DEVELOPER_DIR                Xcode developer directory`);
    process.exit(0);
  }
  const deviceIndex = args.indexOf("--device");
  if (deviceIndex >= 0 && args[deviceIndex + 1]) return args[deviceIndex + 1];
  if (deviceIndex >= 0) fail("Expected a simulator name after --device.");
  return process.env.ORKESTRATOR_IOS_SIMULATOR ?? "iPhone 17 Pro";
}

function runtimeVersion(runtime: string): number[] {
  const match = runtime.match(/iOS-(\d+(?:-\d+)*)$/);
  return (match?.[1] ?? "0").split("-").map(Number);
}

function compareRuntimeDescending(left: string, right: string): number {
  const a = runtimeVersion(left);
  const b = runtimeVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

if (process.platform !== "darwin") fail("The iOS simulator requires macOS.");
if (!existsSync(project)) fail(`Xcode project not found at ${project}.`);
if (!existsSync(developerDirectory)) {
  fail(`Xcode developer directory not found at ${developerDirectory}. Set DEVELOPER_DIR to your Xcode installation.`);
}

const deviceName = requestedDeviceName();
const simulatorList = JSON.parse(
  run("xcrun", ["simctl", "list", "devices", "available", "--json"], true),
) as SimulatorList;
const candidates = Object.entries(simulatorList.devices)
  .sort(([left], [right]) => compareRuntimeDescending(left, right))
  .flatMap(([runtime, devices]) => devices.map((device) => ({ runtime, device })))
  .filter(({ device }) => device.isAvailable && device.name === deviceName);
const selected = candidates[0];

if (!selected) {
  const names = Array.from(new Set(
    Object.values(simulatorList.devices).flat().filter((device) => device.isAvailable).map((device) => device.name),
  )).sort();
  fail(`No available simulator named "${deviceName}". Available devices:\n  ${names.join("\n  ")}`);
}

console.log(`[iOS] Using ${selected.device.name} (${selected.device.udid})`);
if (selected.device.state !== "Booted") {
  console.log("[iOS] Booting simulator…");
  run("xcrun", ["simctl", "boot", selected.device.udid]);
}
run("open", ["-a", "Simulator"]);
run("xcrun", ["simctl", "bootstatus", selected.device.udid, "-b"]);

console.log("[iOS] Building OrkestratorMobile…");
run("xcodebuild", [
  "-project", project,
  "-scheme", "OrkestratorMobile",
  "-configuration", "Debug",
  "-destination", `id=${selected.device.udid}`,
  "-derivedDataPath", derivedData,
  "CODE_SIGNING_ALLOWED=NO",
  "build",
]);

const application = path.join(
  derivedData,
  "Build/Products/Debug-iphonesimulator/OrkestratorMobile.app",
);
if (!existsSync(application)) fail(`Built application not found at ${application}.`);

console.log("[iOS] Installing and launching…");
run("xcrun", ["simctl", "install", selected.device.udid, application]);
run("xcrun", [
  "simctl", "launch", "--terminate-running-process",
  selected.device.udid,
  "dev.orkestrator.mobile",
]);
console.log("[iOS] OrkestratorMobile is running.");
