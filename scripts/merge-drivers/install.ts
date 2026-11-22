#!/usr/bin/env bun
/**
 * Registers a snapshot of this trusted checkout's driver in the common Git
 * directory. Linked worktrees share both the snapshot and its registration.
 * Run with --refresh from a trusted checkout when updating the snapshot.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DRIVERS = {
  "markdown-index": "orkestrator-index",
  "contract-manifest": "orkestrator-contract-manifest",
} as const;
type DriverKind = keyof typeof DRIVERS;

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const fallback = "git merge-file -L ours -L base -L theirs %A %O %B";

function driverCommand(kind: DriverKind, directory: string, bundle: string): string {
  return (
    `test -f ${quote(bundle)} && test -x ${quote(process.execPath)} && ` +
    `exec sh -c ${quote(`cd "$1" && shift && exec ${quote(process.execPath)} --no-env-file ./${quote(bundle.split("/").at(-1)!)} ${kind} "$@"`)} sh ` +
    `${quote(directory)} "$PWD/%O" "$PWD/%A" "$PWD/%B"; ${fallback}`
  );
}

function git(...args: string[]) {
  return spawnSync("git", args, { encoding: "utf8" });
}

function driverKeys() {
  return Object.entries(DRIVERS).map(([kind, name]) => ({
    kind: kind as DriverKind,
    key: `merge.${name}.driver`,
  }));
}

function installed(directory: string): boolean {
  return driverKeys().every(({ kind, key }) => {
    const command = git("config", "--local", "--get", key).stdout.trim();
    const bundle = command.match(/driver-[0-9a-f]{64}\.js/)?.[0];
    return (
      bundle !== undefined &&
      existsSync(join(directory, bundle)) &&
      command === driverCommand(kind, directory, join(directory, bundle))
    );
  });
}

async function main(args: readonly string[]): Promise<number> {
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common.status !== 0) return 1;
  const directory = join(common.stdout.trimEnd(), "orkestrator-merge-drivers");
  const current = installed(directory);
  if (args.includes("--check")) {
    if (!current) console.error("Run mise run git:merge-drivers from a trusted checkout.");
    return current ? 0 : 1;
  }
  if (current && !args.includes("--refresh")) return 0;

  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "driver.ts")],
    target: "bun",
    throw: false,
  });
  const output = build.outputs[0];
  if (!build.success || !output) {
    console.error("Could not bundle the merge drivers.", ...build.logs);
    return 1;
  }

  const bytes = new Uint8Array(await output.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  const bundle = join(directory, `driver-${digest}.js`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, crypto.randomUUID());
  try {
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temp, bundle);
  } finally {
    rmSync(temp, { force: true });
  }

  for (const { kind, key } of driverKeys()) {
    const command = driverCommand(kind, directory, bundle);
    for (let attempt = 0; ; attempt++) {
      if (git("config", "--local", "--get", key).stdout.trim() === command) break;
      const result = git("config", "--local", "--replace-all", key, command);
      if (result.status === 0) break;
      if (attempt === 9 || !result.stderr.includes("could not lock config file")) {
        console.error(`Could not set ${key}: ${result.stderr.trim()}`);
        return 1;
      }
      await Bun.sleep(50 * (attempt + 1));
    }
  }
  console.log("Registered Orkestrator merge drivers.");
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
