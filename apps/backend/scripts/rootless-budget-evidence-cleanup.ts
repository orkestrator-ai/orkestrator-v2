export interface EvidenceDockerResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Discover failed-start containers too, removing only this run's labelled resources. */
export async function cleanupEvidenceContainers(
  docker: (args: string[]) => Promise<EvidenceDockerResult>,
  label: string,
) {
  const list = () => docker(["ps", "-aq", "--filter", `label=${label}`]);
  const before = await list();
  if (!before.ok) {
    return { unresolvedCleanup: [], leftovers: "", cleanupError: before.stderr };
  }
  const unresolvedCleanup: string[] = [];
  for (const id of before.stdout.trim().split(/\s+/).filter(Boolean)) {
    if (!(await docker(["rm", "-f", id])).ok) unresolvedCleanup.push(id);
  }
  const after = await list();
  return {
    unresolvedCleanup,
    leftovers: after.stdout,
    ...(!after.ok ? { cleanupError: after.stderr } : {}),
  };
}
