import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  availableSimulatorNames,
  selectFirstAvailableSimulator,
  selectSimulatorDevice,
  type SimulatorList,
} from "./run-ios-simulator";

const root = path.resolve(import.meta.dir, "..");
const developerDirectory = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const project = path.join(root, "apps/ios/OrkestratorMobile.xcodeproj");
const derivedData = process.env.ORKESTRATOR_IOS_TEST_DERIVED_DATA
  ?? path.join(process.env.TMPDIR ?? "/tmp", "orkestrator-mobile-test-derived");

function fail(message: string): never {
  console.error(`[iOS tests] ${message}`);
  process.exit(1);
}

function capture(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, DEVELOPER_DIR: developerDirectory },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(result.stderr || `${command} exited with status ${result.status}`);
  return result.stdout;
}

if (process.platform !== "darwin") fail("The iOS test suite requires macOS.");
if (!existsSync(developerDirectory)) fail(`Xcode was not found at ${developerDirectory}.`);

let simulatorList: SimulatorList;
try {
  simulatorList = JSON.parse(
    capture("xcrun", ["simctl", "list", "devices", "available", "--json"]),
  ) as SimulatorList;
} catch {
  fail("xcrun returned malformed simulator JSON.");
}

const configuredDeviceName = process.env.ORKESTRATOR_IOS_SIMULATOR;
const deviceName = configuredDeviceName ?? "iPhone 17 Pro";
const selected = selectSimulatorDevice(simulatorList, deviceName)
  ?? (configuredDeviceName ? undefined : selectFirstAvailableSimulator(simulatorList));
if (!selected) {
  fail(`No available simulator named "${deviceName}". Available: ${availableSimulatorNames(simulatorList).join(", ")}`);
}

const result = spawnSync("xcodebuild", [
  "-project", project,
  "-scheme", "OrkestratorMobile",
  "-configuration", "Debug",
  "-destination", `id=${selected.udid}`,
  "-derivedDataPath", derivedData,
  "test",
], {
  cwd: root,
  env: { ...process.env, DEVELOPER_DIR: developerDirectory },
  stdio: "inherit",
});
if (result.error) fail(result.error.message);
if (result.status !== 0) process.exit(result.status ?? 1);
