import { afterEach, describe, expect, test } from "bun:test";
import {
  clearNativeAgentResumeRequest,
  MAX_NATIVE_AGENT_RESUME_REQUESTS,
  NATIVE_AGENT_RESUME_REQUEST_TTL_MS,
  observeNativeAgentResumeRequest,
  parkNativeAgentResumeRequest,
  peekNativeAgentResumeRequest,
  resetNativeAgentResumeRequests,
  runNativeAgentResumeRequest,
} from "./native-agent-resume-requests";

const ref = { nodeId: "node-a", environmentId: "e-1", tabId: "t-1" };
const ready = Promise.resolve(true);

afterEach(() => resetNativeAgentResumeRequests());

describe("native agent resume requests", () => {
  test("a request is read by its own node, environment and tab only", () => {
    parkNativeAgentResumeRequest(ref, { platform: "claude", sessionId: "s-1", ready }, 1_000);
    expect(peekNativeAgentResumeRequest(ref, 1_001)).toMatchObject({ sessionId: "s-1" });
    expect(peekNativeAgentResumeRequest({ ...ref, nodeId: "node-b" }, 1_001)).toBeNull();
    expect(peekNativeAgentResumeRequest({ ...ref, tabId: "t-2" }, 1_001)).toBeNull();
  });

  test("expires, and clearing a replaced request leaves the newer one", () => {
    parkNativeAgentResumeRequest(ref, { platform: "claude", sessionId: "s-1", ready }, 1_000);
    expect(
      peekNativeAgentResumeRequest(ref, 1_000 + NATIVE_AGENT_RESUME_REQUEST_TTL_MS),
    ).toBeNull();

    parkNativeAgentResumeRequest(ref, { platform: "claude", sessionId: "s-1", ready });
    const first = peekNativeAgentResumeRequest(ref)!;
    parkNativeAgentResumeRequest(ref, { platform: "codex", sessionId: "s-2", ready });
    clearNativeAgentResumeRequest(ref, first);
    expect(peekNativeAgentResumeRequest(ref)?.sessionId).toBe("s-2");
    clearNativeAgentResumeRequest(ref);
    expect(peekNativeAgentResumeRequest(ref)).toBeNull();
  });

  test("an observed tab keeps its intent and shares an in-flight resume across mounts", async () => {
    parkNativeAgentResumeRequest(ref, { platform: "claude", sessionId: "s-1", ready }, 1_000);
    const request = peekNativeAgentResumeRequest(ref, 1_001)!;
    expect(observeNativeAgentResumeRequest(ref, request)).toBe(true);
    expect(peekNativeAgentResumeRequest(ref, 1_000 + NATIVE_AGENT_RESUME_REQUEST_TTL_MS)).toBe(
      request,
    );

    const released = Promise.withResolvers<void>();
    const first = runNativeAgentResumeRequest(ref, request, () => released.promise);
    const second = runNativeAgentResumeRequest(ref, request, () => {
      throw new Error("Resume ran twice");
    });
    expect(second).toBe(first);
    released.resolve();
    await second;
    expect(peekNativeAgentResumeRequest(ref)).toBeNull();
  });

  test("holds a bounded number of requests, dropping the oldest", () => {
    for (let index = 0; index <= MAX_NATIVE_AGENT_RESUME_REQUESTS; index += 1) {
      parkNativeAgentResumeRequest(
        { ...ref, tabId: `t-${index}` },
        { platform: "claude", sessionId: `s-${index}`, ready },
      );
    }
    expect(peekNativeAgentResumeRequest({ ...ref, tabId: "t-0" })).toBeNull();
    expect(
      peekNativeAgentResumeRequest({ ...ref, tabId: `t-${MAX_NATIVE_AGENT_RESUME_REQUESTS}` }),
    ).not.toBeNull();
  });
});
