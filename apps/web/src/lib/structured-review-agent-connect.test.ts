import { beforeEach, expect, mock, test } from "bun:test";
import * as realBackend from "@/lib/backend";
import * as realCodexClient from "@/lib/codex-client";
import * as realOpenCodeClient from "@/lib/opencode-client";
import type { Environment } from "@/types";
import type { LoopedReviewWorkflow } from "@/stores/loopedReviewStore";

const getLocalStatus = mock(async () => ({
  running: true,
  port: 4100 as number | null,
  pid: 10 as number | null,
  authToken: "local-token" as string | undefined,
}));
const startLocal = mock(async () => ({
  port: 4100,
  pid: 10,
  authToken: "local-start-token" as string | undefined,
}));
const getContainerStatus = mock(async () => ({
  running: false,
  hostPort: null as number | null,
  authToken: undefined as string | undefined,
}));
const startContainer = mock(async () => ({
  hostPort: 4200,
  authToken: "container-start-token" as string | undefined,
}));
const createClient = mock((baseUrl: string, authToken?: string) => ({
  baseUrl,
  authToken,
}));
const checkHealth = mock(async () => true);
const getLocalOpenCodeStatus = mock(async () => ({
  running: true,
  port: 4500 as number | null,
  pid: 11 as number | null,
  authToken: "local-opencode-secret" as string | undefined,
}));
const startLocalOpenCode = mock(async () => ({
  port: 4500,
  pid: 11,
  authToken: "local-opencode-secret",
}));
const getOpenCodeContainerStatus = mock(async () => ({
  running: false,
  hostPort: null as number | null,
  authToken: undefined as string | undefined,
}));
const startOpenCodeContainer = mock(async () => ({
  hostPort: 4600,
  authToken: "container-opencode-secret",
}));
const createOpenCodeClient = mock((baseUrl: string, directory?: string, authToken?: string) => ({
  baseUrl,
  directory,
  authToken,
}));
const checkOpenCodeHealth = mock(async (_baseUrl: string, _authToken?: string) => true);

mock.module("@/lib/backend", () => ({
  ...realBackend,
  getLocalCodexServerStatus: getLocalStatus,
  startLocalCodexServer: startLocal,
  getCodexServerStatus: getContainerStatus,
  startCodexServer: startContainer,
  getLocalOpencodeServerStatus: getLocalOpenCodeStatus,
  startLocalOpencodeServer: startLocalOpenCode,
  getOpenCodeServerStatus: getOpenCodeContainerStatus,
  startOpenCodeServer: startOpenCodeContainer,
}));
mock.module("@/lib/codex-client", () => ({
  ...realCodexClient,
  createClient,
  checkHealth,
}));
mock.module("@/lib/opencode-client", () => ({
  ...realOpenCodeClient,
  createClient: createOpenCodeClient,
  checkHealth: checkOpenCodeHealth,
}));

const { connectStructuredReviewAgent } = await import("./structured-review-agent");

function workflow(
  agent: LoopedReviewWorkflow["agent"] = "codex",
): LoopedReviewWorkflow {
  return {
    agent,
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
  createOpenCodeClient.mockClear();
  checkOpenCodeHealth.mockClear();
  checkOpenCodeHealth.mockResolvedValue(true);
  getLocalOpenCodeStatus.mockClear();
  startLocalOpenCode.mockClear();
  getOpenCodeContainerStatus.mockClear();
  startOpenCodeContainer.mockClear();
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

test("reuses a running container bridge that already has a token", async () => {
  getContainerStatus.mockResolvedValueOnce({
    running: true,
    hostPort: 4300,
    authToken: "container-token",
  });

  await connectStructuredReviewAgent(workflow(), environment());

  expect(startContainer).not.toHaveBeenCalled();
  expect(createClient).toHaveBeenCalledWith(
    "http://127.0.0.1:4300",
    "container-token",
  );
});

test("throws when the local bridge starts without an authentication token", async () => {
  getLocalStatus.mockResolvedValueOnce({
    running: false,
    port: null,
    pid: null,
    authToken: undefined,
  });
  startLocal.mockResolvedValueOnce({ port: 4100, pid: 10, authToken: undefined });

  await expect(
    connectStructuredReviewAgent(workflow(), environment({
      environmentType: "local",
      containerId: null,
      worktreePath: "/workspace",
    })),
  ).rejects.toThrow("did not return an authentication token");
  expect(createClient).not.toHaveBeenCalled();
});

test("refuses to connect a Codex agent without authentication", async () => {
  // A container bridge that answered without a token: the client would only be
  // able to make unauthenticated requests, so connecting must fail up front.
  startContainer.mockResolvedValueOnce({ hostPort: 4200, authToken: undefined });

  await expect(
    connectStructuredReviewAgent(workflow(), environment()),
  ).rejects.toThrow("Codex bridge authentication is unavailable");
  expect(createClient).not.toHaveBeenCalled();
  expect(checkHealth).not.toHaveBeenCalled();
});

test("health-checks a local OpenCode server before connecting", async () => {
  await connectStructuredReviewAgent(workflow("opencode"), environment({
    environmentType: "local",
    containerId: null,
    worktreePath: "/workspace",
  }));

  expect(checkOpenCodeHealth).toHaveBeenCalledWith(
    "http://127.0.0.1:4500",
    "local-opencode-secret",
  );
  expect(createOpenCodeClient).toHaveBeenCalledWith(
    "http://127.0.0.1:4500",
    "/workspace",
    "local-opencode-secret",
  );
  expect(startLocalOpenCode).not.toHaveBeenCalled();
});

test("refuses to connect an OpenCode agent when the health check fails", async () => {
  checkOpenCodeHealth.mockResolvedValueOnce(false);

  await expect(
    connectStructuredReviewAgent(workflow("opencode"), environment()),
  ).rejects.toThrow("OpenCode server health check failed");
  expect(startOpenCodeContainer).toHaveBeenCalledWith("container-1");
  expect(checkOpenCodeHealth).toHaveBeenCalledWith(
    "http://127.0.0.1:4600",
    "container-opencode-secret",
  );
  expect(createOpenCodeClient).not.toHaveBeenCalled();
});
