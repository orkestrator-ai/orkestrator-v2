import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dir, "..");

interface CommandResult {
  status: number | null;
}

interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: "inherit";
}

export interface TestAllDependencies {
  spawn: (command: string, args: string[], options: CommandOptions) => CommandResult;
  exists: (target: string) => boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  root: string;
}

const defaultDependencies: TestAllDependencies = {
  spawn: (command, args, options) => spawnSync(command, args, options),
  exists: existsSync,
  platform: process.platform,
  env: process.env,
  root,
};

export function runAllTests(
  overrides: Partial<TestAllDependencies> = {},
): number {
  const dependencies = { ...defaultDependencies, ...overrides };

  function run(command: string, args: string[]): number {
    const result = dependencies.spawn(command, args, {
      cwd: dependencies.root,
      env: dependencies.env,
      stdio: "inherit",
    });
    return result.status ?? 1;
  }

  const workspaceStatus = run("turbo", [
    "--cwd", ".",
    "run", "test:workspace",
    "--filter=@orkestrator/web",
    "--filter=@orkestrator/backend",
    "--filter=@orkestrator/web-public",
    "--cache-dir", ".turbo",
  ]);
  if (workspaceStatus !== 0) return workspaceStatus;

  const rootStatus = run("bun", ["test", "tests"]);
  if (rootStatus !== 0) return rootStatus;

  // The bridge packages have no `test` script of their own, so they are not
  // part of the turbo run above. Without this their suites never execute in CI.
  const bridgeStatus = run("bun", ["test", "bridges"]);
  if (bridgeStatus !== 0) return bridgeStatus;

  const xcodeDeveloperDirectory =
    dependencies.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
  if (dependencies.platform === "darwin" && dependencies.exists(xcodeDeveloperDirectory)) {
    return run("bun", ["scripts/test-ios.ts"]);
  }

  return 0;
}

export function main(
  overrides: Partial<TestAllDependencies> = {},
  exit: (status: number) => void = (status) => process.exit(status),
): void {
  const status = runAllTests(overrides);
  if (status !== 0) {
    exit(status);
  }
}

if (import.meta.main) main();
