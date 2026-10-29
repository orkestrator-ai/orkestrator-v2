import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Report a bug against the real backend and a real agent: the sidebar's Bug
 * button opens the sheet, the first message starts a `bug-report:<id>` native
 * session on the host, the agent writes its draft into the scratch directory,
 * the sheet shows it, and Discard removes the report. Nothing is filed.
 *
 * Opt-in: ORKESTRATOR_AGENT_TEST_LIVE_BUG_REPORT=1 against a profile started
 * with an agent credential, for example
 * `mise run dev:test --profile bug-report-qa --fixture --credential-source claude --agent-platforms claude`.
 */

type Status = { status: string; browserUrl?: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

// A live transcript makes a trace larger than the artifact sanitizer accepts.
test.use({ trace: "off" });

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

async function signIn(page: Page, status: Status): Promise<Invoke> {
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
  expect(response?.ok() ?? false).toBe(true);
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args } },
    );
    expect(invokeResponse.ok(), `${command}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

test("a bug report runs a sandboxed host session and shows its draft", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_LIVE_BUG_REPORT !== "1",
    "requires explicit live bug-report qualification opt-in",
  );
  test.setTimeout(6 * 60_000);
  page.setDefaultTimeout(20_000);
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const invoke = await signIn(page, status);
  // Start from no report: an earlier run may have left one open.
  const previous = await invoke<{ report: { id: string } | null }>("get_bug_report");
  if (previous.report) await invoke("discard_bug_report", { reportId: previous.report.id });
  await page.goto(status.browserUrl!, { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "Report a bug" }).click();
  const sheet = page.getByTestId("bug-report-sheet");
  await expect(sheet).toBeVisible();
  const composer = sheet.getByRole("textbox", { name: /Describe what went wrong/ });
  await expect(composer).toBeVisible({ timeout: 60_000 });
  await composer.fill(
    "This is an automated test of the Report a bug flow, not a real problem. Do not ask me " +
      "anything and do not run any commands. Immediately write the draft file named in your " +
      "instructions with the title 'Automated bug report test' and a body containing only a " +
      "'## Summary' section with the word test. Then reply with the single word: done.",
  );
  await composer.press("Enter");

  // The first message is the user's own text: the briefing pointer is hidden.
  await expect(sheet.getByText(/This is an automated test/).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(sheet.getByText("<orkestrator-coordinator-context>")).toHaveCount(0);

  // The scratch write may need an approval under the ask-first policy.
  const deadline = Date.now() + 4 * 60_000;
  const draftTitle = sheet.getByText("Automated bug report test", { exact: true });
  while (Date.now() < deadline && !(await draftTitle.isVisible())) {
    const approve = sheet.getByRole("button", { name: /^(Approve|Allow)/ }).first();
    if (await approve.isVisible().catch(() => false)) await approve.click().catch(() => undefined);
    await page.waitForTimeout(1_000);
  }
  await expect(draftTitle).toBeVisible();
  await expect(sheet.getByRole("button", { name: "File issue" })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("bug-report-draft.png") });

  const snapshot = await invoke<{ report: { runtimeId: string; agent?: string } | null }>(
    "get_bug_report",
  );
  expect(snapshot.report?.runtimeId).toMatch(/^bug-report:/);
  expect(snapshot.report?.agent).toBeTruthy();

  await sheet.getByRole("button", { name: "Discard" }).click();
  await sheet.getByRole("button", { name: "Discard report?" }).click();
  await expect(sheet).toBeHidden();
  expect((await invoke<{ report: unknown }>("get_bug_report")).report).toBeNull();
});
