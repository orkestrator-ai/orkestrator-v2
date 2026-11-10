/**
 * Lifecycle context for the live host-reach suites: an in-memory store whose
 * agent tools server answers on `servicePort`, the one host port a restricted
 * runtime's firewall admits, and a project with no reachable remote.
 */
import type { Environment } from "../src/core/models";
import { memoryLifecycleContext } from "./container-lifecycle-fixtures";

export function hostServiceContext(
  environments: Environment[],
  dataDir: string,
  servicePort: number,
) {
  const fixture = memoryLifecycleContext(environments, dataDir);
  Object.assign(fixture.context, {
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
    agentTools: {
      connection: () => {
        throw new Error("not used");
      },
      revokeEnvironment: () => undefined,
      servicePort: () => servicePort,
    },
  });
  Object.assign(fixture.context.storage, {
    getProject: async () => ({
      id: "project-1",
      name: "Project",
      gitUrl: "https://example.invalid/none.git",
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: { allowedDomains: ["registry.npmjs.org"], enabledAgentPlatforms: [] },
      repositories: {},
    }),
  });
  return fixture;
}
