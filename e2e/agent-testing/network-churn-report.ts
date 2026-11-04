import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const NETWORK_CHANGED = "net::ERR_NETWORK_CHANGED";

/**
 * Names the failed cases whose page lost requests to a host network change, which
 * show up as an ordinary "element not found" (flake 2340). The suite only keeps a
 * trace for a failed attempt, so every archive here is one. This reports evidence
 * and changes no result; it prints directory names and counts, nothing from the trace.
 */
export function networkChurnReport(
  artifactsDirectory: string,
  maxBuffer = 512 * 1024 * 1024,
): string | null {
  let cases: string[];
  try {
    cases = readdirSync(artifactsDirectory);
  } catch {
    return null;
  }
  const affected = cases.flatMap((name) => {
    const traces = spawnSync(
      "unzip",
      ["-p", path.join(artifactsDirectory, name, "trace.zip"), "*.trace"],
      { encoding: "utf8", maxBuffer },
    );
    if (traces.status !== 0) return [];
    const count = traces.stdout.split(NETWORK_CHANGED).length - 1;
    return count > 0 ? [`  ${name}: ${count}`] : [];
  });
  if (affected.length === 0) return null;
  return [
    `${affected.length} failed case(s) have ${NETWORK_CHANGED} in their trace. Chromium aborted their requests because a host network interface changed; see flake 2340 before reading these as test failures.`,
    ...affected,
  ].join("\n");
}
