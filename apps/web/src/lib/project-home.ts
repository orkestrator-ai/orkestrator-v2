import type { Environment } from "@/types";

/**
 * The project's home environment: the one that works directly in the
 * project's own checkout. It has no sidebar row of its own; selecting the
 * project activates it.
 */
export function findProjectHomeEnvironment(
  environments: readonly Environment[],
  projectId: string,
): Environment | undefined {
  return environments.find(
    (environment) =>
      environment.projectId === projectId &&
      environment.projectHome === true &&
      !environment.deletionRequestedAt,
  );
}

/** The environments that get their own sidebar row. */
export function withoutProjectHomes(environments: readonly Environment[]): Environment[] {
  return environments.filter((environment) => environment.projectHome !== true);
}
