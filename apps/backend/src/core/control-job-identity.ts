import { createHash } from "node:crypto";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { isRecord } from "./storage-shared-core.js";
import { paneLayoutLeaves } from "./storage-shared-pane-layout.js";

/** The persisted tab is the authority for the platform chosen on first launch. */
export function controlJobId(environmentId: string, requestId: string): string {
  return createHash("sha256")
    .update(environmentId)
    .update("\0")
    .update(requestId)
    .digest("hex")
    .slice(0, 24);
}

export function savedControlJobAgent(layout: unknown, environmentId: string, requestId: string) {
  const tab = isRecord(layout)
    ? paneLayoutLeaves(layout.root)
        .flatMap((leaf) => leaf.tabs)
        .find((tab) => tab.id === `agent-job-${controlJobId(environmentId, requestId)}`)
    : undefined;
  const platform = isRecord(tab?.nativeAgentData) ? tab.nativeAgentData.platform : undefined;
  return isAgentPlatform(platform) ? platform : undefined;
}
