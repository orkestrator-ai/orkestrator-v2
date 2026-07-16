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

export interface SimulatorDevice {
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

export interface SimulatorList {
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

export interface SimulatorArguments {
  deviceName: string;
  help: boolean;
}

export function parseSimulatorArguments(
  rawArgs: string[],
  defaultDeviceName = "iPhone 17 Pro",
): SimulatorArguments {
  const args = rawArgs.filter((argument) => argument !== "--");
  if (args.includes("--help") || args.includes("-h")) {
    return { deviceName: defaultDeviceName, help: true };
  }
  const deviceIndex = args.indexOf("--device");
  if (deviceIndex >= 0 && args[deviceIndex + 1]) {
    return { deviceName: args[deviceIndex + 1], help: false };
  }
  if (deviceIndex >= 0) throw new Error("Expected a simulator name after --device.");
  return { deviceName: defaultDeviceName, help: false };
}

export function runtimeVersion(runtime: string): number[] {
  const match = runtime.match(/iOS-(\d+(?:-\d+)*)$/);
  return (match?.[1] ?? "0").split("-").map(Number);
}

export function compareRuntimeDescending(left: string, right: string): number {
  const a = runtimeVersion(left);
  const b = runtimeVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function selectSimulatorDevice(
  simulatorList: SimulatorList,
  deviceName: string,
): SimulatorDevice | undefined {
  return Object.entries(simulatorList.devices)
    .sort(([left], [right]) => compareRuntimeDescending(left, right))
    .flatMap(([runtime, devices]) => devices.map((device) => ({ runtime, device })))
    .filter(({ device }) => device.isAvailable && device.name === deviceName)[0]?.device;
}

export function selectFirstAvailableSimulator(
  simulatorList: SimulatorList,
  deviceFamily = "iPhone",
): SimulatorDevice | undefined {
  return Object.entries(simulatorList.devices)
    .sort(([left], [right]) => compareRuntimeDescending(left, right))
    .flatMap(([, devices]) => devices)
    .find((device) => device.isAvailable && device.name.startsWith(deviceFamily));
}

export function availableSimulatorNames(simulatorList: SimulatorList): string[] {
  return Array.from(new Set(
    Object.values(simulatorList.devices).flat().filter((device) => device.isAvailable).map((device) => device.name),
  )).sort();
}

export function builtApplicationPath(derivedDataPath: string): string {
  return path.join(derivedDataPath, "Build/Products/Debug-iphonesimulator/OrkestratorMobile.app");
}

export function main(): void {
  if (process.platform !== "darwin") fail("The iOS simulator requires macOS.");
  if (!existsSync(project)) fail(`Xcode project not found at ${project}.`);
  if (!existsSync(developerDirectory)) {
    fail(`Xcode developer directory not found at ${developerDirectory}. Set DEVELOPER_DIR to your Xcode installation.`);
  }

  let parsedArguments: SimulatorArguments;
  try {
    parsedArguments = parseSimulatorArguments(
      process.argv.slice(2),
      process.env.ORKESTRATOR_IOS_SIMULATOR ?? "iPhone 17 Pro",
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (parsedArguments.help) {
    console.log(`Usage: bun run dev:ios [--device "iPhone 17 Pro"]

Environment variables:
  ORKESTRATOR_IOS_SIMULATOR    Default simulator device name
  ORKESTRATOR_IOS_DERIVED_DATA Build output directory
  DEVELOPER_DIR                Xcode developer directory`);
    return;
  }

  let simulatorList: SimulatorList;
  try {
    simulatorList = JSON.parse(
      run("xcrun", ["simctl", "list", "devices", "available", "--json"], true),
    ) as SimulatorList;
  } catch {
    fail("xcrun returned malformed simulator JSON.");
  }
  const selected = selectSimulatorDevice(simulatorList, parsedArguments.deviceName);
  if (!selected) {
    const names = availableSimulatorNames(simulatorList);
    fail(`No available simulator named "${parsedArguments.deviceName}". Available devices:\n  ${names.join("\n  ")}`);
  }

  console.log(`[iOS] Using ${selected.name} (${selected.udid})`);
  if (selected.state !== "Booted") {
    console.log("[iOS] Booting simulator…");
    run("xcrun", ["simctl", "boot", selected.udid]);
  }
  run("open", ["-a", "Simulator"]);
  run("xcrun", ["simctl", "bootstatus", selected.udid, "-b"]);

  console.log("[iOS] Building OrkestratorMobile…");
  run("xcodebuild", [
    "-project", project,
    "-scheme", "OrkestratorMobile",
    "-configuration", "Debug",
    "-destination", `id=${selected.udid}`,
    "-derivedDataPath", derivedData,
    "CODE_SIGNING_ALLOWED=NO",
    "build",
  ]);

  const application = builtApplicationPath(derivedData);
  if (!existsSync(application)) fail(`Built application not found at ${application}.`);

  console.log("[iOS] Installing and launching…");
  run("xcrun", ["simctl", "install", selected.udid, application]);
  run("xcrun", [
    "simctl", "launch", "--terminate-running-process",
    selected.udid,
    "dev.orkestrator.mobile",
  ]);
  console.log("[iOS] OrkestratorMobile is running.");
}

if (import.meta.main) main();
