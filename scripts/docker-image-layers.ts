import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * Image and layer sizes for to-do 1202 task 14 (DK-7 to DK-9), on whatever
 * Docker the host has.
 *
 *   bun scripts/docker-image-layers.ts report TAG [--du PATH]...
 *   bun scripts/docker-image-layers.ts changed BASE_TAG PROBE_TAG
 *
 * `report` prints the image size, every layer (uncompressed bytes and the
 * instruction that made it) and, per `--du`, `du -sxk` of that path inside a
 * throwaway `--network none` container (null when the path is absent).
 * `changed` prints the layers of PROBE_TAG that BASE_TAG does not have and
 * their total bytes: build BASE_TAG, change a source, build PROBE_TAG with the
 * same builder, and this is what a client holding BASE_TAG would pull.
 * Read-only apart from the throwaway containers, which `--rm` removes.
 */

export type Layer = { diffId: string; size: number; createdBy: string };
export type HistoryRow = { size: number; createdBy: string };

/**
 * Pairs `RootFS.Layers` (oldest first) with `docker history` rows (newest
 * first). Only rows with a size made a layer; anything else (ENV, ARG,
 * metadata) is skipped. Throws if the counts disagree, rather than guess.
 */
export function pairLayers(diffIds: string[], history: HistoryRow[]): Layer[] {
  const rows = history.filter((row) => row.size > 0).reverse();
  if (rows.length !== diffIds.length) {
    throw new Error(
      `${diffIds.length} layers but ${rows.length} history rows with a size; cannot pair them`,
    );
  }
  return diffIds.map((diffId, index) => ({
    diffId,
    size: rows[index]!.size,
    createdBy: rows[index]!.createdBy,
  }));
}

/** Layers of `probe` whose content `base` does not already hold. */
export function changedLayers(
  base: Layer[],
  probe: Layer[],
): { layers: Layer[]; bytes: number; total: number } {
  const held = new Set(base.map((layer) => layer.diffId));
  const layers = probe.filter((layer) => !held.has(layer.diffId));
  return {
    layers,
    bytes: layers.reduce((sum, layer) => sum + layer.size, 0),
    total: probe.length,
  };
}

/** `du -sxk` output to bytes; null when du printed no size. */
export function parseDuKib(output: string): number | null {
  const match = /^(\d+)\s/.exec(output.trim());
  return match ? Number(match[1]) * 1024 : null;
}

function docker(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export function readLayers(tag: string): Layer[] {
  const diffIds = JSON.parse(
    docker(["image", "inspect", "--format", "{{json .RootFS.Layers}}", tag]),
  );
  const history = docker(["history", "--no-trunc", "--human=false", "--format", "{{json .}}", tag])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as { Size: string | number; CreatedBy: string };
      return { size: Number(row.Size), createdBy: row.CreatedBy };
    });
  return pairLayers(diffIds, history);
}

function report(tag: string, duPaths: string[]) {
  const [size, architecture] = docker([
    "image",
    "inspect",
    "--format",
    "{{.Size}} {{.Architecture}}",
    tag,
  ])
    .trim()
    .split(" ");
  const du: Record<string, number | null> = {};
  for (const path of duPaths) {
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "root",
        "--entrypoint",
        "du",
        tag,
        "-sxk",
        path,
      ],
      { encoding: "utf8" },
    );
    du[path] = result.status === 0 ? parseDuKib(result.stdout) : null;
  }
  return { tag, size: Number(size), architecture, layers: readLayers(tag), du };
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "report" && rest[0]) {
    const duPaths: string[] = [];
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === "--du" && rest[index + 1]) duPaths.push(rest[++index]!);
      else throw new Error(`Unknown argument ${rest[index]}`);
    }
    process.stdout.write(`${JSON.stringify(report(rest[0], duPaths), null, 2)}\n`);
  } else if (command === "changed" && rest[0] && rest[1]) {
    const result = changedLayers(readLayers(rest[0]), readLayers(rest[1]));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stderr.write(
      "usage: docker-image-layers.ts report TAG [--du PATH]... | changed BASE_TAG PROBE_TAG\n",
    );
    process.exit(2);
  }
}
