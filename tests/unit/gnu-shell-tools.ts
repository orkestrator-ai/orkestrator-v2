import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * The container scripts run on the Linux image's GNU tools: `date -d`,
 * `tar --no-wildcards-match-slash` and similar have no BSD equivalent. Shell
 * fixtures put Homebrew's GNU tools ahead of the inherited PATH when they are
 * installed (the testing guide's macOS prerequisites), so the suite does not
 * depend on how the caller's shell orders its PATH. On Linux the inherited
 * tools are already GNU and nothing is added.
 */
const HOMEBREW_GNU_DIRS = [
  "bash/bin",
  "coreutils/libexec/gnubin",
  "findutils/libexec/gnubin",
  "gnu-tar/libexec/gnubin",
  "grep/libexec/gnubin",
  "gnu-sed/libexec/gnubin",
];

export const gnuToolPath = [
  ...["/opt/homebrew/opt", "/usr/local/opt"].flatMap((prefix) =>
    HOMEBREW_GNU_DIRS.map((dir) => join(prefix, dir)).filter((dir) => existsSync(dir)),
  ),
  process.env.PATH ?? "",
].join(delimiter);

const GNU_SIGNATURES = {
  date: "GNU coreutils",
  du: "GNU coreutils",
  rm: "GNU coreutils",
  tar: "GNU tar",
} as const;

/** Skip reason when `tools` on {@link gnuToolPath} are not the GNU builds, else undefined. */
export function missingGnuTools(...tools: (keyof typeof GNU_SIGNATURES)[]): string | undefined {
  const missing = tools.filter((tool) => {
    const run = spawnSync(tool, ["--version"], { encoding: "utf8", env: { PATH: gnuToolPath } });
    return !run.stdout?.includes(GNU_SIGNATURES[tool]);
  });
  if (missing.length === 0) return undefined;
  return `needs GNU ${missing.join(", ")} (macOS: brew install coreutils gnu-tar; see docs/development/testing-guide.md)`;
}

/** A test title that carries its skip reason, since Bun prints no reason of its own. */
export const titleWithSkip = (title: string, skip: string | undefined) =>
  skip ? `${title} (skipped: ${skip})` : title;
