/**
 * Browser checks for interactions under each approval policy (todo 0001 task 7),
 * with provider fakes behind the real bridges:
 *
 * - a Codex MCP elicitation rehydrates after the environment goes inactive and
 *   after a reload, then answers and cancels through the bridge;
 * - a Claude session overridden to `ask` raises an approval card whose approve,
 *   deny and cancel reach the SDK callback;
 * - a Claude session overridden to `deny` refuses a tool without a card while
 *   a question still reaches the user;
 * - a coordinator turn delegates through Orkestrator's MCP tools, is refused a
 *   write without a card, and asks the user a question.
 *
 * Claude's own MCP elicitation is covered by `ClaudeInteractions.spec.ts`.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import path from "node:path";
import {
  startInteractionFixtureHost,
  stopInteractionFixtureHost,
  type InteractionFixtureHost as Host,
} from "./interaction-fixture-host";

// A test may start the bridge host it uses, which imports a whole bridge.
test.describe.configure({ timeout: 60_000 });

const startHost = (script: string, env: Record<string, string> = {}) =>
  startInteractionFixtureHost(path.join(import.meta.dirname, "fixtures", script), env);
const stopHost = stopInteractionFixtureHost;

/**
 * One host per kind and worker, started by the first test that needs it: each
 * imports a whole bridge, so a worker starts only the ones its tests use.
 */
const hosts = new Map<string, Promise<Host>>();
const host = (script: string, env: Record<string, string> = {}): Promise<Host> => {
  const key = `${script}:${JSON.stringify(env)}`;
  if (!hosts.has(key)) hosts.set(key, startHost(script, env));
  return hosts.get(key)!;
};
const claude = () => host("claude-interactions-host.ts");
const coordinator = () => host("claude-interactions-host.ts", { CLAUDE_FIXTURE_COORDINATOR: "1" });
// A Codex child owns one answer log. Give each test its own child/log so no
// session can satisfy its assertions with an earlier session's responses.
let codexInstance = 0;
const codex = () =>
  host("codex-elicitation-host.ts", { CODEX_FIXTURE_INSTANCE: String(++codexInstance) });
test.afterAll(async () => {
  const started = await Promise.allSettled(hosts.values());
  hosts.clear();
  await Promise.all(
    started.map((result) => (result.status === "fulfilled" ? stopHost(result.value) : undefined)),
  );
});

interface Snapshot {
  snapshot: { requests: Array<{ kind: string }> };
  activity?: string;
  stopped?: boolean;
  result?: unknown;
  history?: Array<{ behavior?: string; message?: string; updatedInput?: unknown }>;
  answers?: Array<{ action?: string; content?: unknown }>;
  delegations?: Array<{ environmentId: string; status: string; toolUseId: string }>;
  delegationResults?: Array<{ toolUseId: string; state: string; output: string }>;
  policy?: string;
  allowedTools?: string[];
}

/** Opens the fixture page on one session of `host`, routing its calls there. */
async function openSession(
  page: Page,
  request: APIRequestContext,
  pending: Promise<Host>,
  start: Record<string, unknown> = {},
) {
  const { origin } = await pending;
  await page.route("**/__claude-test/**", async (route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    const response = await request.fetch(
      `${origin}${url.pathname.replace("/__claude-test", "")}${url.search}`,
      { method: incoming.method(), data: incoming.postData() ?? undefined },
    );
    await route.fulfill({ response });
  });
  const { sessionId } = (await (await request.post(`${origin}/start`, { data: start })).json()) as {
    sessionId: string;
  };
  const snapshot = async () =>
    (await (await request.get(`${origin}/snapshot?session=${sessionId}`)).json()) as Snapshot;
  const post = (route: string, data: unknown) =>
    request.post(`${origin}/${route}?session=${sessionId}`, { data });
  await page.goto(`/claude-interactions?session=${sessionId}`);
  return { sessionId, snapshot, post };
}

for (const mode of ["form", "url"] as const) {
  test(`Codex MCP ${mode} elicitation rehydrates after an inactive environment and reload, then answers and cancels`, async ({
    page,
    request,
  }) => {
    const { snapshot, post } = await openSession(page, request, codex());
    expect((await snapshot()).answers).toEqual([]);
    await page.getByRole("button", { name: "Switch environment", exact: true }).click();
    await post("raise", { mode });
    await expect.poll(async () => (await snapshot()).activity).toBe("waiting");
    await page.getByRole("button", { name: "Return to environment", exact: true }).click();
    const title = mode === "form" ? "MCP server needs input" : "MCP authorization";
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (mode === "form")
      await page.getByRole("textbox", { name: "Team", exact: true }).fill("core");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const accepted = {
      action: "accept",
      content: mode === "form" ? { team: "core" } : {},
      _meta: null,
    };
    // What the bridge wrote back to the app-server child.
    await expect.poll(async () => (await snapshot()).answers).toEqual([accepted]);
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);

    await post("raise", { mode });
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel turn", exact: true }).click();
    await expect
      .poll(async () => (await snapshot()).answers)
      .toEqual([accepted, { action: "cancel", content: null, _meta: null }]);
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  });
}

test("a Claude session overridden to ask raises approval cards whose approve, deny and cancel reach the SDK", async ({
  page,
  request,
}) => {
  const { snapshot, post } = await openSession(page, request, claude(), { approvals: "ask" });
  const card = page.getByText("Approve command", { exact: true });

  await post("raise", { mode: "tool", tool: "Bash", input: { command: "touch approved.txt" } });
  await expect(card).toBeVisible();
  await expect(page.getByText("Command: touch approved.txt", { exact: false })).toBeVisible();
  // The card is the bridge's parked request, not page state.
  await page.reload();
  await expect(card).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(async () => (await snapshot()).history?.[0]?.behavior).toBe("allow");
  await expect(card).toHaveCount(0);

  await post("raise", {
    mode: "tool",
    tool: "Edit",
    input: { file_path: "/fixture/notes.md", old_string: "a", new_string: "b" },
  });
  const fileCard = page.getByText("Approve file changes", { exact: true });
  await expect(fileCard).toBeVisible();
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect.poll(async () => (await snapshot()).history?.[1]?.behavior).toBe("deny");
  await expect(fileCard).toHaveCount(0);
  expect((await snapshot()).stopped).toBe(false);

  await post("raise", { mode: "tool", tool: "Bash", input: { command: "touch cancelled.txt" } });
  await expect(card).toBeVisible();
  await page.getByRole("button", { name: "Cancel turn", exact: true }).click();
  await expect.poll(async () => (await snapshot()).stopped).toBe(true);
  await expect(card).toHaveCount(0);
});

test("a Claude session overridden to deny refuses a tool without a card and still asks a question", async ({
  page,
  request,
}) => {
  const { snapshot, post } = await openSession(page, request, claude(), { approvals: "deny" });
  await post("raise", { mode: "tool", tool: "Bash", input: { command: "touch refused.txt" } });
  await expect
    .poll(async () => (await snapshot()).history?.[0])
    .toMatchObject({ behavior: "deny", message: expect.stringContaining("denies approvals") });
  expect((await snapshot()).snapshot.requests).toEqual([]);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

  await post("raise", { mode: "question" });
  await expect(page.getByText("Claude needs input", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Core" }).click();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect
    .poll(async () => (await snapshot()).history?.[1])
    .toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Which fixture team?": "Core" } },
    });
  await expect(page.getByText("Claude needs input", { exact: true })).toHaveCount(0);
});

test("a coordinator turn delegates through Orkestrator tools, is refused a write and asks a question", async ({
  page,
  request,
}) => {
  const { snapshot, post } = await openSession(page, request, coordinator());
  const initial = await snapshot();
  // The launcher's process authority, not the session's own request.
  expect(initial.policy).toBe("coordinator-read-only");
  // The CLI runs an allowed tool without consulting `canUseTool`; the bridge's
  // read-only hook is the gate it does consult.
  expect(initial.allowedTools).toContain("mcp__orkestrator__*");
  const delegation = await (
    await post("delegate", {
      tool: "mcp__orkestrator__launch_environment",
      input: { name: "worker", prompt: "Make the change" },
    })
  ).json();
  expect(delegation).toMatchObject({
    environmentId: expect.any(String),
    status: "running",
    toolUseId: expect.any(String),
  });
  expect((await snapshot()).delegations).toEqual([delegation]);
  // The same SDK turn has consumed the launch receipt through the real bridge.
  await expect
    .poll(async () => (await snapshot()).delegationResults)
    .toEqual([
      {
        toolUseId: delegation.toolUseId,
        state: "success",
        output: expect.stringContaining(delegation.environmentId),
      },
    ]);
  const write = await (
    await post("pre-tool-use", {
      tool: "Write",
      input: { file_path: "/fixture/notes.md", content: "changed" },
    })
  ).json();
  expect(write.hookSpecificOutput).toMatchObject({
    permissionDecision: "deny",
    permissionDecisionReason: expect.stringContaining("read-only"),
  });
  // A write that reaches `canUseTool` anyway is refused there, with no card.
  await post("raise", {
    mode: "tool",
    tool: "Write",
    input: { file_path: "/fixture/notes.md", content: "changed" },
  });
  await expect.poll(async () => (await snapshot()).history?.[0]?.behavior).toBe("deny");
  expect((await snapshot()).snapshot.requests).toEqual([]);

  await post("raise", { mode: "question" });
  await expect(page.getByText("Claude needs input", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Claude needs input", { exact: true })).toBeVisible();
  expect((await snapshot()).delegations).toEqual([delegation]);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Docs" }).click();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect
    .poll(async () => (await snapshot()).history?.[1])
    .toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Which fixture team?": "Docs" } },
    });
});
