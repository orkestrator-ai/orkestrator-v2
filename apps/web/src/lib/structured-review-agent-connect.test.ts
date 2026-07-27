import { beforeEach, expect, mock, test } from "bun:test";
import * as realBackend from "@/lib/backend";
import * as realCodexClient from "@/lib/codex-client";
import type { Environment } from "@/types";
import type { LoopedReviewWorkflow } from "@/stores/loopedReviewStore";

const getLocalStatus = mock(async () => ({
  running: true,
  port: 4100,
  pid: 10,
  authToken: "local-token",
}));
const startLocal = mock(async () => ({
  port: 4100,
  pid: 10,
  authToken: "local-start-token",
}));
const getContainerStatus = mock(async () => ({
  running: false,
  hostPort: null,
  authToken: undefined as string | undefined,
}));
const startContainer = mock(async () => ({
  hostPort: 4200,
  authToken: "container-start-token",
}));
const createClient = mock((baseUrl: string, authToken?: string) => ({
  baseUrl,
  authToken,
}));
const checkHealth = mock(async () => true);

mock.module("@/lib/backend", () => ({
  ...realBackend,
  getLocalCodexServerStatus: getLocalStatus,
  startLocalCodexServer: startLocal,
  getCodexServerStatus: getContainerStatus,
  startCodexServer: startContainer,
}));
mock.module("@/lib/codex-client", () => ({
  ...realCodexClient,
  createClient,
  checkHealth,
}));

const { connectStructuredReviewAgent } = await import("./structured-review-agent");

function workflow(): LoopedReviewWorkflow {
  return {
    agent: "codex",
    model: "default",
    sessions: [],
  } as unknown as LoopedReviewWorkflow;
}

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "environment-1",
    projectId: "project-1",
    name: "review",
    branch: "review",
    status: "running",
    containerId: "container-1",
    environmentType: "containerized",
    worktreePath: null,
    ...overrides,
  } as Environment;
}

beforeEach(() => {
  createClient.mockClear();
  checkHealth.mockClear();
  checkHealth.mockResolvedValue(true);
  getLocalStatus.mockClear();
  startLocal.mockClear();
  getContainerStatus.mockClear();
  startContainer.mockClear();
});

test("connects a local Codex review agent with the running bridge token", async () => {
  await connectStructuredReviewAgent(workflow(), environment({
    environmentType: "local",
    containerId: null,
    worktreePath: "/workspace",
  }));

  expect(createClient).toHaveBeenCalledWith("http://127.0.0.1:4100", "local-token");
  expect(checkHealth).toHaveBeenCalledWith({
    baseUrl: "http://127.0.0.1:4100",
    authToken: "local-token",
  });
  expect(startLocal).not.toHaveBeenCalled();
});

test("starts a container Codex bridge and propagates its token", async () => {
  await connectStructuredReviewAgent(workflow(), environment());

  expect(startContainer).toHaveBeenCalledWith("container-1");
  expect(createClient).toHaveBeenCalledWith(
    "http://127.0.0.1:4200",
    "container-start-token",
  );
});
