/**
 * `scripts/coordinator-probes/grok-web-tools-probe.mjs data-dir-reads`
 * (to-do 7401 task 1), run against a fake ACP agent standing in for `grok`.
 *
 * The real run needs a Grok login and is on the manual-test checklist; this
 * proves the probe records what that run has to answer: every permission
 * request with the paths it names and the bridge's `reject_once` answer, every
 * `fs/read_text_file` with the bridge's workspace confinement, every tool call
 * with its locations and final status, and whether a fixture canary reached a
 * reply. It also proves no real path and no data-directory reply is printed.
 */
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const PROBE = path.join(repositoryRoot, "scripts/coordinator-probes/grok-web-tools-probe.mjs");

/**
 * Answers `--version`, then speaks just enough ACP over stdio. Per prompt:
 * the README is read through `fs/read_text_file`; the data-directory file read
 * asks permission (naming the path) and then tries the client read anyway; the
 * listing runs without asking and returns the real names; the search refuses.
 */
const FAKE_GROK = String.raw`#!/usr/bin/env bun
import { readdirSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("grok 0.0.0-fake");
  process.exit(0);
}
let nextId = 1000;
const pending = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const call = (method, params) => {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
};
const update = (sessionId, value) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
const say = (sessionId, text) =>
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
let cwd = "";
async function prompt(id, params) {
  const sessionId = params.sessionId;
  const text = params.prompt.map((part) => part.text).join("");
  const target = /(\/\S+?)(?: with|\s|$)/.exec(text)?.[1];
  if (text.includes("README.md")) {
    const answer = await call("fs/read_text_file", { sessionId, path: cwd + "/README.md" });
    say(sessionId, answer.result?.content?.trim() ?? "REFUSED");
  } else if (text.includes("control-mcp.json")) {
    const permission = await call("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: "read-1",
        title: "Read " + target,
        kind: "read",
        locations: [{ path: target }],
        rawInput: { path: target },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed = permission.result?.outcome?.optionId === "allow";
    const read = await call("fs/read_text_file", { sessionId, path: target });
    say(sessionId, allowed && read.result ? read.result.content : "REFUSED");
  } else if (text.includes("List the entries")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "list-1",
      title: "List " + target,
      kind: "read",
      status: "pending",
      locations: [{ path: target }],
    });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "list-1", status: "completed" });
    say(sessionId, readdirSync(target).join("\n"));
  } else {
    say(sessionId, "REFUSED");
  }
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}
let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id != null && !message.method) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } else if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (message.method === "session/new") {
      cwd = message.params.cwd;
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-session" } });
    } else if (message.method === "session/prompt") {
      void prompt(message.id, message.params);
    }
  }
});
`;

const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("data-dir-reads records permission requests, client reads, tool calls and leaks, with labelled paths only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "grok-read-probe-test-"));
  roots.push(root);
  const fake = path.join(root, "fake-grok");
  await writeFile(fake, FAKE_GROK);
  await chmod(fake, 0o755);
  const child = Bun.spawn([process.execPath, PROBE, "data-dir-reads"], {
    cwd: root,
    env: {
      ...process.env,
      GROK_BIN: fake,
      HOME: root,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const timer = setTimeout(() => child.kill(), 25_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const result = JSON.parse(stdout) as {
    variant: string;
    version: string;
    steps: Array<{
      step: string;
      toolCalls: Array<{ kind: string; title: string; locations: string[]; status: string }>;
      permissionRequests: Array<{
        kind: string;
        title: string;
        paths: string[];
        dataDir: boolean;
        answer: string;
      }>;
      clientReads: Array<{ path: string; answer: string }>;
      leaked: boolean;
    }>;
    summary: Record<string, boolean>;
    finding: string;
  };
  expect(result.variant).toBe("data-dir-reads");
  expect(result.version).toBe("grok 0.0.0-fake");
  expect(result.steps.map((step) => step.step)).toEqual([
    "workspace-read",
    "data-dir-read",
    "data-dir-list",
    "data-dir-search",
  ]);
  const [control, read, list, search] = result.steps;
  // The control: a workspace read is served through the client, as the bridge serves it.
  expect(control!.clientReads).toEqual([{ path: "<workspace>/README.md", answer: "served" }]);
  expect(control!.leaked).toBe(true);
  // A read that asks names the data directory and is refused with reject_once,
  // and the client read of the same path is refused by the workspace confinement.
  expect(read!.permissionRequests).toEqual([
    {
      title: "Read <data-dir>/control-mcp.json",
      kind: "read",
      paths: ["<data-dir>/control-mcp.json"],
      dataDir: true,
      answer: "reject_once",
    },
  ]);
  expect(read!.clientReads).toEqual([{ path: "<data-dir>/control-mcp.json", answer: "refused" }]);
  expect(read!.leaked).toBe(false);
  // A listing that never asks is recorded with its location and status, and leaks.
  expect(list!.permissionRequests).toEqual([]);
  expect(list!.toolCalls).toEqual([
    { title: "List <data-dir>", kind: "read", locations: ["<data-dir>"], status: "completed" },
  ]);
  expect(list!.leaked).toBe(true);
  expect(search!).toMatchObject({ toolCalls: [], permissionRequests: [], leaked: false });
  expect(result.summary).toEqual({
    workspaceReadWorked: true,
    readsAskPermission: true,
    askedWithDataDirPath: true,
    clientReadsOfDataDir: true,
    dataDirLeaked: true,
  });
  expect(result.finding).toContain("asks before a data-directory read");
  // No real path, no canary and no data-directory reply reaches the output.
  expect(stdout).not.toContain(root);
  expect(stdout).not.toContain(tmpdir());
  expect(stdout).not.toMatch(/probe-(?:token|search|workspace)-[0-9a-f]{12}/);
  expect(stdout).not.toContain("orkestrator.sqlite");
}, 30_000);
