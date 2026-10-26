/**
 * Cleanup for the live Docker suites: exactly the resources a run labelled,
 * removed one per call, then listed again.
 *
 * Under load Docker Desktop 4.95 intermittently answered a multi-argument
 * `docker rm -f` or `docker volume rm` with "404 page not found". A hook that
 * removed everything in one call and ignored the error leaked silently. One
 * resource per call keeps a failure to that resource, and the returned
 * leftovers let the hook assert that nothing is left. Never a prune.
 */

type Docker = (args: string[]) => Promise<string>;

const KINDS = [
  { name: "container", list: ["ps", "-aq"], remove: ["rm", "-f"] },
  { name: "volume", list: ["volume", "ls", "-q"], remove: ["volume", "rm"] },
  { name: "network", list: ["network", "ls", "-q"], remove: ["network", "rm"] },
] as const;

async function listed(docker: Docker, list: readonly string[], filters: readonly string[]) {
  const ids = new Set<string>();
  for (const filter of filters) {
    const output = await docker([...list, "--filter", filter]);
    for (const id of output.split("\n")) if (id.trim()) ids.add(id.trim());
  }
  return [...ids].sort();
}

/**
 * Removes every container, then volume, then network matching any of
 * `filters` (`label=…`), one per call. Returns what is still there, as
 * `"<kind> <id>"`, or `"<kind> unlisted"` when it could not be listed again.
 */
export async function removeLabelledResources(
  docker: Docker,
  filters: readonly string[],
): Promise<string[]> {
  const leftovers: string[] = [];
  if (filters.length === 0) return leftovers;
  for (const kind of KINDS) {
    for (const id of await listed(docker, kind.list, filters).catch(() => [])) {
      await docker([...kind.remove, id]).catch(() => undefined);
    }
    try {
      leftovers.push(
        ...(await listed(docker, kind.list, filters)).map((id) => `${kind.name} ${id}`),
      );
    } catch {
      leftovers.push(`${kind.name} unlisted`);
    }
  }
  return leftovers;
}
