/**
 * Lifecycle context for the live host-reach suites: an in-memory store whose
 * agent tools server answers on `servicePort`, the one host port a restricted
 * runtime's firewall admits, and a project with no reachable remote.
 */
import {
  AGENT_TOOLS_LOOPBACK_PROBE_PATH,
  AGENT_TOOLS_LOOPBACK_PROOF_HEADER,
  agentToolsLoopbackProof,
} from "../src/core/agent-tools-loopback-proof";
import type { Environment } from "../src/core/models";
import { AGENT_TOOLS_PROBE_HTTP_STATUS } from "../src/core/containers/host-reachability";
import { memoryLifecycleContext } from "./container-lifecycle-fixtures";

/**
 * What a stand-in for the agent tools server answers on its service port: the
 * real server's 405 to a non-POST `/mcp`, an optional signed loopback proof,
 * and `answer` (200) for the suites' curl probes of `/`.
 */
export function agentToolsStandIn(
  request: Request,
  answer: string,
  signLoopbackProbe?: (challenge: string) => string,
): Response {
  const url = new URL(request.url);
  if (url.pathname === AGENT_TOOLS_LOOPBACK_PROBE_PATH) {
    const proof =
      request.method === "GET" && signLoopbackProbe
        ? agentToolsLoopbackProof(url, signLoopbackProbe)
        : null;
    return proof
      ? new Response(null, { headers: { [AGENT_TOOLS_LOOPBACK_PROOF_HEADER]: proof } })
      : new Response(null, { status: 404 });
  }
  if (url.pathname === "/mcp" && request.method !== "POST") {
    return new Response(null, {
      status: AGENT_TOOLS_PROBE_HTTP_STATUS,
      headers: { allow: "POST" },
    });
  }
  return new Response(answer);
}

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
