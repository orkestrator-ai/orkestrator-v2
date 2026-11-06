// MCP elicitations from a scripted app-server child through the real Codex
// bridge routes and backend normalization. The child is the bridge's own fake
// `codex` binary, so nothing here reaches a model or reads provider secrets.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { HttpBridgeInteractionAdapter } from "../../apps/backend/src/core/http-bridge/interactions";

installFatalRejectionGuard({ label: "[codex-elicitation-browser-fixture]" });
const root = mkdtempSync(join(tmpdir(), "codex-elicitation-browser-"));
const codexHome = join(root, "codex-home");
const workspace = mkdtempSync(join(root, "workspace-"));
const fakeCodex = join(
  import.meta.dirname,
  "../../bridges/codex-bridge/src/testing/fake-codex-app-server.mjs",
);
chmodSync(fakeCodex, 0o755);
const token = "codex-elicitation-fixture-token";
Object.assign(process.env, {
  CODEX_BRIDGE_NO_SERVER: "1",
  CODEX_PATH: fakeCodex,
  CODEX_HOME: codexHome,
  CWD: workspace,
  CODEX_BRIDGE_TOKEN: token,
  FAKE_CODEX_SCRIPT: "elicitation",
});
// Never hand the fake child a real credential or the Orkestrator instance this
// run was started from.
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("ORKESTRATOR_AGENT_MCP_") ||
    ["OPENAI_API_KEY", "CODEX_API_KEY", "GITHUB_TOKEN", "GH_TOKEN"].includes(key)
  )
    delete process.env[key];
}
const { app } = await import("../../bridges/codex-bridge/src/index");
const bridgeFetch = ((input: string | URL | Request, init?: RequestInit) =>
  app.request(String(input).replace("http://fixture", ""), init)) as typeof fetch;
const adapter = new HttpBridgeInteractionAdapter(
  "codex",
  { agent: "codex", baseUrl: "http://fixture", authToken: token },
  bridgeFetch,
);
const bridge = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("X-Orkestrator-Codex-Token", token);
  headers.set("Content-Type", "application/json");
  return app.request(path, { ...init, headers });
};

const deadline = Date.now() + 20_000;
for (;;) {
  const health = (await (await app.request("/global/health")).json()) as {
    appServer?: { state?: string };
  };
  if (health.appServer?.state === "ready") break;
  if (Date.now() > deadline) throw new Error("the fake app-server never became ready");
  await Bun.sleep(50);
}

const answersFile = join(codexHome, "elicitation-answers.jsonl");
const answers = () =>
  existsSync(answersFile)
    ? readFileSync(answersFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { result: unknown })
        .map((entry) => entry.result)
    : [];
let prompts = 0;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/start") {
      const created = (await (
        await bridge("/session/create", { method: "POST", body: JSON.stringify({ mode: "build" }) })
      ).json()) as { sessionId: string };
      return Response.json({ sessionId: created.sessionId });
    }
    const sessionId = url.searchParams.get("session")!;
    if (url.pathname === "/raise") {
      const { mode } = (await req.json()) as { mode: "form" | "url" };
      const response = await bridge(`/session/${sessionId}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: `raise a ${mode}`, requestId: `raise-${++prompts}` }),
      });
      return Response.json({ raised: response.ok, status: response.status });
    }
    if (url.pathname === "/snapshot") {
      const activity = (await (await bridge(`/session/${sessionId}/activity`)).json()) as {
        activity?: string;
      };
      return Response.json({
        snapshot: await adapter.listPendingInteractions(sessionId),
        activity: activity.activity,
        answers: answers(),
      });
    }
    if (url.pathname === "/hold") {
      const { interactionId, held } = (await req.json()) as {
        interactionId: string;
        held: boolean;
      };
      return Response.json(await adapter.holdInteraction(sessionId, interactionId, held));
    }
    if (url.pathname === "/resolve") {
      const resolution = await req.json();
      return Response.json(
        await adapter.resolveInteraction(sessionId, resolution.interactionId, resolution),
      );
    }
    return new Response("Unknown fixture route", { status: 404 });
  },
});
console.log(`INTERACTION_FIXTURE_READY:${server.port}`);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
    process.exit(0);
  });
