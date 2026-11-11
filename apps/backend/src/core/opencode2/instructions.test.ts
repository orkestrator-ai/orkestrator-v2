import { afterEach, expect, test } from "bun:test";
import { agentSystemInstructions } from "@orkestrator/protocol/agent-system-instructions";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import { OPENCODE2_INSTRUCTIONS_KEY, attachOpenCode2Instructions } from "./instructions.js";
import { OpenCode2Provider } from "./provider.js";

let server: FakeOpenCode2Server | undefined;
let provider: OpenCode2Provider | undefined;
afterEach(async () => {
  await provider?.dispose();
  server?.stop();
  provider = undefined;
  server = undefined;
});

function setup() {
  server = new FakeOpenCode2Server();
  provider = new OpenCode2Provider(server.client(), { monitorEvents: false });
  return { server, provider };
}

test("a new session carries Orkestrator's shared instructions as a durable entry", async () => {
  const { server, provider } = setup();
  const id = await provider.createSession("build", "Tab");
  expect(server.sessions.get(id)?.instructions).toEqual({
    [OPENCODE2_INSTRUCTIONS_KEY]: agentSystemInstructions(),
  });
});

test("a read-only coordinator's session gets none, as on every other provider", async () => {
  const { server } = setup();
  const id = (await server.client().createSession({})).id;
  await attachOpenCode2Instructions(server.client(), id, { id: "coordinator-read-only" });
  expect(server.sessions.get(id)?.instructions).toBeUndefined();
});

test("a server that refuses the entry still runs the session", async () => {
  const { server } = setup();
  await attachOpenCode2Instructions(server.client(), "ses_missing");
  expect(server.sessions.size).toBe(0);
});
