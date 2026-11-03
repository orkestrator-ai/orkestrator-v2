import { closeSync, openSync, readSync, fstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * CLI array overrides replace every lower layer. Keep all exclusion patterns
 * from system, user and ancestor project configs, including profile tables.
 * Taking the union (even for inactive profiles) is deliberately conservative:
 * choosing another profile must never reveal a previously filtered variable.
 * Only data is read; no project hooks or other configuration are executed.
 */
export function configuredShellExclusions(env: NodeJS.ProcessEnv): string[] {
  const paths = new Set([
    "/etc/codex/config.toml",
    join(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"), "config.toml"),
  ]);
  {
    let directory = resolve(env.CWD || process.cwd());
    for (;;) {
      paths.add(join(directory, ".codex", "config.toml"));
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const exclusions = new Set<string>();
  for (const path of paths) {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Cannot read Codex shell exclusions");
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024) {
        throw new Error("Invalid Codex configuration file");
      }
      // One extra byte detects growth after stat without an unbounded read.
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > 1024 * 1024) throw new Error("Codex configuration too large");
      const config = Bun.TOML.parse(buffer.subarray(0, length).toString("utf8"));
      collect(config, exclusions);
    } catch {
      // Do not launch with a weaker list if configured exclusions cannot be read.
      // The parser's error can contain file contents, so never forward it.
      throw new Error("Cannot load Codex shell exclusions");
    } finally {
      closeSync(fd);
    }
  }
  return [...exclusions];
}

function collect(config: unknown, exclusions: Set<string>): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) return;
  const table = config as Record<string, unknown>;
  const policy = table.shell_environment_policy as Record<string, unknown> | undefined;
  if (policy && Object.hasOwn(policy, "exclude")) {
    if (!Array.isArray(policy.exclude) || policy.exclude.some((item) => typeof item !== "string")) {
      throw new Error("Invalid Codex shell exclusions");
    }
    for (const pattern of policy.exclude) exclusions.add(pattern);
  }
  if (table.profiles && typeof table.profiles === "object") {
    for (const profile of Object.values(table.profiles)) collect(profile, exclusions);
  }
}
