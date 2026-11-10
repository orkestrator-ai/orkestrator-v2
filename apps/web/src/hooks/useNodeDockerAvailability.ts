import { useEffect, useState } from "react";
import type { DockerAvailability } from "@orkestrator/protocol/docker-availability";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createDockerSkillsApi } from "@/lib/backend/docker-skills";
import type { NodeScope } from "@/lib/node-scope/node-scope";

const log = createLogger("web.node-scope");

/** How often a shown node's Docker daemon is probed, as the window probes its own. */
export const IN_TREE_DOCKER_POLL_INTERVAL_MS = 60_000;

/**
 * The node's Docker daemon, probed on its own scope: `true`/`false`, or
 * `null` until the first answer (and after a failed read, which says nothing
 * about Docker). The window's own probe is the command node's.
 */
export function useNodeDockerAvailability(scope: NodeScope, active = true): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!active) return;
    let current = true;
    const probe = () => {
      backendApiForScope(scope, createDockerSkillsApi, backend)
        .checkDocker()
        .then(
          (result: DockerAvailability | null) => {
            if (!current) return;
            // A malformed answer says nothing about Docker.
            setAvailable(typeof result?.available === "boolean" ? result.available : null);
          },
          (error: unknown) => {
            if (current)
              log.warn("service.failed", { service: "docker-probe", error: formatLogError(error) });
          },
        );
    };
    probe();
    const timer = setInterval(probe, IN_TREE_DOCKER_POLL_INTERVAL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [active, scope]);
  return available;
}
