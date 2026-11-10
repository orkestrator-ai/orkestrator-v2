import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Which kind of backend made a host-reachability probe network or container,
 * as the value of `DOCKER_LABEL_CREATOR`: `<runtime flavor>/<data directory
 * kind>`, for example `agent-test/temporary` or `production/persistent`.
 *
 * The owner label is a hash of the data directory. When that directory was
 * temporary, which is every disposable test backend, nothing left on the host
 * maps the hash back to whatever ran it, so a leaked network could not even be
 * told apart from a profile's or production's (todo 7470 task 2). This label
 * can, and `disk:report` counts leaked networks by it.
 *
 * Labels are readable by anyone who can reach the daemon, so the value is
 * content-free by construction: a flavor from a fixed set and one of two
 * words. Never a path, a user name or a spec name.
 */
export type ProbeCreatorFlavor = "production" | "development" | "agent-test";
export type ProbeCreatorDataDir = "temporary" | "persistent";
export type ProbeCreator = `${ProbeCreatorFlavor}/${ProbeCreatorDataDir}`;

/** Every value {@link probeCreator} can produce, for readers that validate a label. */
export const PROBE_CREATOR_PATTERN =
  /^(production|development|agent-test)\/(temporary|persistent)$/;

function canonical(target: string): string[] {
  const resolved = path.resolve(target);
  try {
    const real = realpathSync(resolved);
    return real === resolved ? [resolved] : [resolved, real];
  } catch {
    return [resolved];
  }
}

function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Whether `dataDir` lies under the system temporary directory (`os.tmpdir()`,
 * or `/tmp` on POSIX), comparing resolved and real paths so macOS's
 * `/var/folders` ↔ `/private/var/folders` link does not hide it.
 */
export function isTemporaryDataDir(
  dataDir: string,
  temporaryRoots: readonly string[] = [tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])],
): boolean {
  const candidates = canonical(dataDir);
  const roots = temporaryRoots.flatMap(canonical);
  return candidates.some((candidate) => roots.some((root) => within(candidate, root)));
}

export function probeCreator(
  runtimeFlavor: ProbeCreatorFlavor,
  dataDir: string,
  temporaryRoots?: readonly string[],
): ProbeCreator {
  return `${runtimeFlavor}/${isTemporaryDataDir(dataDir, temporaryRoots) ? "temporary" : "persistent"}`;
}
