import { createHash } from "node:crypto";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";

export function nativeAgentSessionStorageKey(
  environmentId: string,
  agent: BuildPipelineAgent,
  logicalSessionKey: string,
): string {
  return createHash("sha256")
    .update(environmentId)
    .update("\0")
    .update(agent)
    .update("\0")
    .update(logicalSessionKey)
    .digest("hex");
}
