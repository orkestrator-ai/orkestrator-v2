import { expect, type TestInfo } from "@playwright/test";
import type { WebAnnotationRequest } from "@orkestrator/protocol/web-annotations";
import { isSignInError } from "../../apps/desktop/scripts/dev/coordinator-live";

type RequestState = Pick<WebAnnotationRequest, "state" | "blockedReason" | "stateReason">;

/** Poll authoritative state, settling a parked rejection as soon as it arrives. */
export async function waitForLiveAnnotationRequest(options: {
  readRequest(): Promise<RequestState>;
  agent: string;
  profile: string;
  testInfo: TestInfo;
  /** Keep waiting through `needs-input` (an interaction already answered). */
  throughInput?: boolean;
}): Promise<WebAnnotationRequest["state"]> {
  const { readRequest, agent, profile, testInfo, throughInput = false } = options;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let latest: RequestState | undefined;
  await expect
    .poll(
      async () => {
        latest = await readRequest();
        if (latest.state === "queued" && latest.blockedReason === "dispatch-rejected") return true;
        // Slow providers need progress output for test:logged's watchdog.
        if (Date.now() - lastProgressAt >= 60_000) {
          lastProgressAt = Date.now();
          const elapsed = Math.round((lastProgressAt - startedAt) / 1_000);
          console.log(`[annotation-live] ${agent} request ${latest.state} after ${elapsed} s`);
        }
        return [
          "awaiting-review",
          "completed",
          "failed",
          "cancelled",
          "unconfirmed",
          ...(throughInput ? [] : ["needs-input"]),
        ].includes(latest.state);
      },
      { timeout: 840_000, intervals: [5_000] },
    )
    .toBe(true);

  // Report a parked rejection outside the polling predicate, giving it one
  // explicit skip or failure instead of waiting for a terminal request state.
  if (!latest) throw new Error("No annotation request state was read");
  if (latest.state === "queued" && latest.blockedReason === "dispatch-rejected") {
    const reason = (latest.stateReason ?? "no reason recorded").slice(0, 300);
    testInfo.annotations.push({ type: "live-request-state", description: `queued: ${reason}` });
    if (isSignInError(reason)) {
      testInfo.skip(true, `no usable ${agent} credential in profile "${profile}": ${reason}`);
    }
    throw new Error(`${agent} rejected the annotation request: ${reason}`);
  }
  return latest.state;
}
