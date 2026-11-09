import { describe, expect, test } from "bun:test";
import { openCode2TurnConnections, openCode2WorkerMailbox } from "./turn-connections.js";

const TAB = { url: "http://127.0.0.1:9/mcp", token: "tab-token" };
const BROKER = { url: "http://127.0.0.1:9/mcp", token: "broker", workflowResultCapability: "cap" };
const MAIL = { environmentId: "env", tabId: "pipeline-worker:s1", capability: "wm.signed" };
const WORKER = { url: "http://host.docker.internal:9/mcp", token: "worker-token", design: true };

describe("openCode2TurnConnections", () => {
  test("a result turn's grant becomes the broker connection's artifact server", async () => {
    const options = await openCode2TurnConnections(
      { requestId: "r", agentMcp: { ...BROKER, design: true }, artifactGrant: "grant-1" },
      undefined,
    );
    expect(options).toEqual({
      requestId: "r",
      agentMcp: { ...BROKER, artifacts: { token: "grant-1" } },
    });
  });

  test("a grant the caller already put on the connection is kept, not replaced", async () => {
    const options = await openCode2TurnConnections(
      {
        requestId: "r",
        agentMcp: { ...BROKER, artifacts: { token: "own" } },
        artifactGrant: "other",
      },
      undefined,
    );
    expect(options.agentMcp?.artifacts).toEqual({ token: "own" });
  });

  test("a tab-scoped connection carries artifact authority and the mailbox itself", async () => {
    const options = await openCode2TurnConnections(
      {
        requestId: "r",
        agentMcp: { ...TAB, design: true },
        artifactGrant: "grant-1",
        tabMail: { environmentId: "env", tabId: "tab-1" },
      },
      undefined,
    );
    expect(options).toEqual({ requestId: "r", agentMcp: { ...TAB, design: true } });
  });

  test("a worker turn gets its mailbox's own connection; the capability itself is not sent", async () => {
    const asked: unknown[] = [];
    const options = await openCode2TurnConnections(
      { requestId: "r", workerMail: MAIL, artifactGrant: "grant-1" },
      async (mail) => {
        asked.push(mail);
        return WORKER;
      },
    );
    expect(asked).toEqual([MAIL]);
    expect(options).toEqual({ requestId: "r", agentMcp: WORKER });
    expect(JSON.stringify(options)).not.toContain("wm.signed");
    expect(JSON.stringify(options)).not.toContain("grant-1");
  });

  test("a worker turn whose mailbox cannot be issued runs without Orkestrator tools", async () => {
    for (const mailbox of [
      undefined,
      async () => undefined,
      async () => {
        throw new Error("agent tools server is down");
      },
    ]) {
      expect(await openCode2TurnConnections({ requestId: "r", workerMail: MAIL }, mailbox)).toEqual(
        { requestId: "r" },
      );
    }
  });

  test("a turn's own connection wins over worker mail", async () => {
    let asked = false;
    const options = await openCode2TurnConnections(
      { requestId: "r", agentMcp: BROKER, workerMail: MAIL },
      async () => {
        asked = true;
        return WORKER;
      },
    );
    expect(asked).toBe(false);
    expect(options).toEqual({ requestId: "r", agentMcp: BROKER });
  });
});

describe("openCode2WorkerMailbox", () => {
  const scope = { environmentId: "env", projectId: "p", tabId: MAIL.tabId };
  function mailbox(
    options: {
      authenticated?: typeof scope | null;
      environment?: { id: string; projectId: string; environmentType: "local" | "containerized" };
    } = {},
  ) {
    const issued: unknown[][] = [];
    const resolve = openCode2WorkerMailbox("env", {
      authenticate: () => (options.authenticated === undefined ? scope : options.authenticated),
      getEnvironment: async () =>
        options.environment ?? { id: "env", projectId: "p", environmentType: "local" },
      connection: (...args) => {
        issued.push(args);
        return { url: "http://127.0.0.1:9/mcp", token: "worker" };
      },
    });
    return { resolve, issued };
  }

  test("issues the worker's own mailbox connection on the environment's side of the host", async () => {
    const host = mailbox();
    expect(await host.resolve(MAIL)).toEqual({ url: "http://127.0.0.1:9/mcp", token: "worker" });
    expect(host.issued).toEqual([["env", "p", "host", MAIL.tabId]]);
    const container = mailbox({
      environment: { id: "env", projectId: "p", environmentType: "containerized" },
    });
    await container.resolve(MAIL);
    expect(container.issued).toEqual([["env", "p", "container", MAIL.tabId]]);
  });

  test("refuses a capability that does not name this environment's worker", async () => {
    const cases = [
      mailbox({ authenticated: null }),
      mailbox({ authenticated: { ...scope, environmentId: "other" } }),
      mailbox({ authenticated: { ...scope, tabId: "pipeline-worker:s2" } }),
      mailbox({ environment: { id: "env", projectId: "other", environmentType: "local" } }),
    ];
    for (const { resolve, issued } of cases) {
      expect(await resolve(MAIL)).toBeUndefined();
      expect(issued).toEqual([]);
    }
    const { resolve, issued } = mailbox();
    expect(await resolve({ ...MAIL, environmentId: "other" })).toBeUndefined();
    expect(issued).toEqual([]);
  });
});
