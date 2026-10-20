/**
 * Rich transcripts and transcript artifacts in the real stack, against a
 * `dev:test --fixture` profile (`ORKESTRATOR_AGENT_TEST_PROFILE`) holding the
 * provider's credentials.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_RICH_TRANSCRIPTS=1`): it runs real
 * provider turns. Provider: `ORKESTRATOR_AGENT_TEST_RICH_PROVIDER` (default
 * codex). Model: `ORKESTRATOR_AGENT_TEST_RICH_MODEL` (default the provider's
 * own default; for Codex the first GPT model the catalogue offers). Pi's
 * default is the first model of its signed-in provider, which can be retired
 * and end the turn silently; pass a current model for Pi.
 *
 * 1. A real agent authors the offline calculator through the ordinary tools:
 *    a deliberately wrong first revision fails its declared probe, the repair
 *    passes, and only the matching receipt publishes. The transcript shows the
 *    verified card; Run interactive frames the trusted viewer shell, whose
 *    `frame-src` names only the document, and the document runs inside
 *    `sandbox="allow-scripts"` and computes 96; the document is served with
 *    the generated CSP and no-store/nosniff/no-referrer; it never paints over
 *    application chrome; a reload recovers the same publication from the
 *    ledger.
 * 2. The same agent echoes the specification's rich Markdown fixture plus a
 *    chart fence: callout, disclosure, table, Mermaid and the native chart
 *    render; find reveals a match inside the collapsed disclosure and restores
 *    it on close; a 390 px viewport has no horizontal overflow and no toolbar
 *    button outside its card.
 *
 * Prompts, transcript text and capability URLs never reach test output.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type Status = { status: string; browserUrl?: string };
type Envelope<T> = { ok: boolean; result: T; receipt?: { resources?: Record<string, string> } };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const launcher = path.join(repositoryRoot, "packages", "cli", "bin", "orkestrator.js");
const enabled = process.env.ORKESTRATOR_AGENT_TEST_LIVE_RICH_TRANSCRIPTS === "1";
/** `ORKESTRATOR_AGENT_TEST_RICH_PROVIDER`: claude, codex (default), opencode, cursor, grok or pi. */
const provider = process.env.ORKESTRATOR_AGENT_TEST_RICH_PROVIDER ?? "codex";
const PROVIDER_TAB_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
  pi: "Pi",
};
/** Providers whose CLI runs report completion; the others are followed through the ledger. */
const COMPLETION_QUALIFIED = new Set(["claude", "codex", "opencode"]);
const providerTab = new RegExp(`^${PROVIDER_TAB_LABEL[provider] ?? provider} \\d+`);

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

function cli<T>(configDir: string, args: string[], timeoutMs = 20 * 60_000): Envelope<T> {
  const command = spawnSync("bun", [launcher, "--profile", profile, ...args, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ORKESTRATOR_CLI_CONFIG_DIR: configDir },
  });
  return JSON.parse(command.stdout) as Envelope<T>;
}

async function login(page: Page) {
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const { loginUrl } = JSON.parse(command.stdout) as { loginUrl: string };
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
}

async function openConversation(page: Page, browserUrl: string, environment: string, tab: RegExp) {
  await page.goto(browserUrl);
  const expand = page.getByRole("button", { name: /^Expand project / }).first();
  await expand.waitFor({ timeout: 30_000 }).catch(() => undefined);
  if (await expand.isVisible()) await expand.click();
  await page.getByText(environment, { exact: true }).first().click();
  await page.getByText(tab).first().click();
  await expect(
    page.locator("[data-virtuoso-scroller]").filter({ visible: true }).first(),
  ).toBeVisible({
    timeout: 60_000,
  });
}

/** Scroll the transcript with real wheel input (programmatic scrolls re-stick to the bottom). */
async function wheelUntil(page: Page, predicate: () => Promise<boolean>, maxSteps = 80) {
  const scroller = page.locator("[data-virtuoso-scroller]").filter({ visible: true }).first();
  const box = (await scroller.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < maxSteps; step++) {
    if (await predicate()) return true;
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(200);
  }
  return predicate();
}

/**
 * Content-free timing on the test's output: each call marks the start of the
 * named stage, so a timeout shows where the time went.
 */
const stageStartedAt = Date.now();
function stage(name: string) {
  console.log(
    `[rich-live] ${provider} ${name} +${Math.round((Date.now() - stageStartedAt) / 1000)}s`,
  );
}

const CALCULATOR_PROMPT = `This is a test of Orkestrator's transcript artifact tools. Do not edit repository files.
Use the orkestrator tools create_artifact, preview_artifact, get_artifact_operation, update_artifact and publish_artifact to build an html-interactive artifact titled "Task time calculator":
a range input (min 0, max 20, value 5) with data-artifact-test="tasks", a number input (value 12) with data-artifact-test="minutes", and an <output data-artifact-test="total"> showing tasks × minutes, using addEventListener (no inline handlers, no external resources, no imports).
Probes: [{"op":"expect-text","target":"total","equals":"60"},{"op":"set-number","target":"tasks","value":8},{"op":"expect-number","target":"total","equals":96},{"op":"set-number","target":"minutes","value":0},{"op":"expect-number","target":"total","equals":0}].
First create revision 1 with a deliberate bug (total = tasks × 10), preview it and wait for the result. Then fix it with update_artifact, preview revision 2, wait for success, and publish revision 2 with its receipt.
Finish with one line exactly: RESULT revision1=<status> revision2=<status> publication=<publication id>`;

// A 30-minute live trace exceeds the artifact sanitizer's bound; screenshots stay on failure.
test.use({ trace: "off" });

test.describe("rich transcripts live", () => {
  test.skip(
    !enabled,
    "Set ORKESTRATOR_AGENT_TEST_LIVE_RICH_TRANSCRIPTS=1 on a profile with the provider's credentials",
  );
  test.setTimeout(60 * 60_000);

  test("a real agent repairs, publishes and runs a verified interactive artifact, and rich Markdown renders", async ({
    page,
  }, testInfo) => {
    page.setDefaultTimeout(30_000);
    const status = profileStatus();
    expect(status.status).toBe("ready");
    const configDir = mkdtempSync(path.join(os.tmpdir(), "ork-rich-live-"));
    const suffix = Math.random().toString(36).slice(2, 8);
    const environmentName = `rich-live-${suffix}`;
    let environment: string | undefined;
    try {
      const projects = cli<{ items: Array<{ id: string }> }>(configDir, ["project", "list"]);
      const projectId = projects.result.items[0]!.id;
      const created = cli<{ environment: { id: string } }>(configDir, [
        "environment",
        "create",
        "--project",
        projectId,
        "--type",
        "local",
        "--name",
        environmentName,
        "--request-id",
        `rich-live:${suffix}:create`,
      ]);
      environment = created.result.environment.id;
      let startedEnvironment = cli(configDir, [
        "environment",
        "start",
        environment,
        "--wait",
        "ready",
        "--timeout",
        "10m",
      ]);
      // A just-created environment can still be finishing its own setup; one retry.
      if (!startedEnvironment.ok) {
        startedEnvironment = cli(configDir, [
          "environment",
          "start",
          environment,
          "--wait",
          "ready",
          "--timeout",
          "10m",
        ]);
      }
      expect(
        startedEnvironment.ok,
        JSON.stringify((startedEnvironment as { error?: unknown }).error),
      ).toBe(true);

      const options = cli<{
        agents: Array<{ agent: string; catalogue?: { models?: Array<{ id: string }> } }>;
      }>(configDir, ["agent", "options", "--environment", environment]);
      const providerModels =
        options.result.agents.find((agent) => agent.agent === provider)?.catalogue?.models ?? [];
      // Codex's account default can be unavailable to ChatGPT sign-in; prefer a catalogue GPT model.
      const model =
        process.env.ORKESTRATOR_AGENT_TEST_RICH_MODEL ??
        (provider === "codex"
          ? providerModels.find((candidate) => candidate.id.startsWith("gpt-"))?.id
          : undefined);
      if (provider === "codex") expect(model, "no Codex model in the catalogue").toBeTruthy();

      const promptFile = path.join(configDir, "calculator.txt");
      writeFileSync(promptFile, CALCULATOR_PROMPT);
      stage("authoring");
      const started = cli(configDir, [
        "session",
        "start",
        "--environment",
        environment,
        "--agent",
        provider,
        ...(model ? ["--model", model] : []),
        "--prompt-file",
        promptFile,
        "--wait",
        "--timeout",
        "15m",
        "--request-id",
        `rich-live:${suffix}:calc`,
      ]);
      // Cursor, Grok and Pi cannot report completion; their outcome is read from the ledger below.
      if (COMPLETION_QUALIFIED.has(provider)) {
        expect(started.ok, JSON.stringify((started as { error?: unknown }).error)).toBe(true);
      }
      const sessionId = started.receipt!.resources!.sessionId!;
      const tabId = started.receipt!.resources!.tabId!;
      testInfo.annotations.push({ type: "provider", description: provider });

      await login(page);
      const invoke = async <T>(command: string, args: Record<string, unknown>) => {
        const response = await page.request.post(
          new URL("/__orkestrator/invoke", status.browserUrl).toString(),
          {
            data: { command, args },
          },
        );
        expect(response.ok()).toBe(true);
        return ((await response.json()) as { result: T }).result;
      };
      const scope = {
        environmentId: environment,
        logicalSessionKey: `env-${environment}:${tabId}`,
      };
      type Ledger = {
        publications: Array<{ ref: { publicationId: string; kind: string; revision: number } }>;
      };
      let ledger = await invoke<Ledger>("transcript_artifact_list_publications", scope);
      // The authoritative ledger, not the provider's completion signal, says when it published.
      for (
        let waited = 0;
        waited < 15 * 60_000 &&
        !ledger.publications.some((publication) => publication.ref.kind === "html-interactive");
        waited += 5_000
      ) {
        await page.waitForTimeout(5_000);
        ledger = await invoke<Ledger>("transcript_artifact_list_publications", scope);
      }
      const calculator = ledger.publications.find(
        (publication) => publication.ref.kind === "html-interactive",
      );
      expect(calculator?.ref.revision).toBe(2);
      testInfo.annotations.push({
        type: "publication",
        description: calculator!.ref.publicationId,
      });

      stage("card");
      await openConversation(page, status.browserUrl!, environmentName, providerTab);
      const card = page
        .locator('[data-rich-block="artifact"]')
        .filter({ hasText: "Task time calculator" })
        .first();
      expect(await wheelUntil(page, async () => (await card.count()) > 0)).toBe(true);
      // A ledger read may precede the provider overlay. Once painted, the
      // same card must survive that reconciliation under the same React row.
      await card.scrollIntoViewIfNeeded({ timeout: 30_000 });
      const paintedCard = await card.elementHandle();
      await page.waitForTimeout(1_500);
      expect(await paintedCard?.evaluate((node) => node.isConnected)).toBe(true);
      await expect(card.locator("figcaption")).toContainText("Revision 2");
      await expect(card.locator("figcaption")).toContainText("Interactions verified by 5 probes");

      const shellResponse = page.waitForResponse((response) =>
        /\/s\/[A-Za-z0-9_-]{20,}$/.test(response.url()),
      );
      const documentResponse = page.waitForResponse((response) =>
        /\/a\/[A-Za-z0-9_-]{20,}$/.test(response.url()),
      );
      stage("run-interactive");
      await card.getByRole("button", { name: /Run interactive/i }).click();
      // The application page frames the trusted viewer shell, whose policy
      // allows exactly the one document URL as a child frame.
      const shell = await shellResponse;
      const served = await documentResponse;
      const shellHeaders = await shell.allHeaders();
      expect(shell.status()).toBe(200);
      expect(shellHeaders["content-security-policy"]).toContain(`frame-src ${served.url()}`);
      expect(shellHeaders.location).toBeUndefined();
      const headers = await served.allHeaders();
      expect(served.status()).toBe(200);
      expect(headers["content-security-policy"]).toContain("sandbox allow-scripts");
      expect(headers["content-security-policy"]).toContain("connect-src 'none'");
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["cache-control"]).toContain("no-store");
      expect(headers["referrer-policy"]).toBe("no-referrer");
      expect(headers.location).toBeUndefined();

      const shellElement = page.locator("iframe[data-artifact-live-frame]").first();
      await expect(shellElement).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
      const shellFrame = page.frameLocator("iframe[data-artifact-live-frame]").first();
      await expect(shellFrame.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
      const frame = shellFrame.frameLocator("iframe").first();
      await frame.locator('[data-artifact-test="tasks"]').fill("8");
      await expect(frame.locator('[data-artifact-test="total"]')).toHaveText("96");

      // Scroll the card partly under the tab strip: the live document is clipped to the transcript.
      await card.evaluate((element) => element.scrollIntoView({ block: "start" }));
      await page.mouse.wheel(0, 250);
      await page.waitForTimeout(600);
      const clipPath = await page.evaluate(() => {
        let element =
          document.querySelector("iframe[data-artifact-live-frame]")?.parentElement ?? null;
        while (element && !getComputedStyle(element).clipPath.startsWith("inset"))
          element = element.parentElement;
        return element ? getComputedStyle(element).clipPath : "none";
      });
      expect(clipPath).toMatch(/^inset\(\d/);

      stage("reload");
      await page.reload();
      await openConversation(page, status.browserUrl!, environmentName, providerTab);
      expect(
        await wheelUntil(
          page,
          async () =>
            (await page
              .locator('[data-rich-block="artifact"]')
              .filter({ hasText: "Task time calculator" })
              .count()) > 0,
        ),
      ).toBe(true);

      // Rich Markdown fixture from the specification, plus a chart fence.
      const specification = readFileSync(
        path.join(repositoryRoot, "docs/architecture/transcript-artifacts-agent-guide.md"),
        "utf8",
      );
      const chartStart =
        specification.indexOf('```json\n{\n  "schemaVersion": 1') + "```json\n".length;
      const chart = specification.slice(chartStart, specification.indexOf("```", chartStart));
      const fixture = [
        "## Review notes",
        "",
        "> [!NOTE]",
        "> The following is a synthetic rendering fixture.",
        "",
        "<details>",
        "<summary>Inspect the implementation notes</summary>",
        "",
        "Use `src/example.ts:12` to inspect the example.",
        "",
        '```ts title="Example" filename="src/example.ts"',
        "const label = `Count: ${items.length}`;",
        "console.log(label);",
        "```",
        "",
        "</details>",
        "",
        "| Check | Result | Notes |",
        "| :--- | ---: | :--- |",
        "| Unit tests | 44 | Synthetic fixture |",
        '| Browser tests | 8 | Quotes: "kept" |',
        "",
        "```mermaid",
        "flowchart TD",
        "  A[Input] --> B{Valid?}",
        "  B -->|Yes| C[Render]",
        "  B -->|No| D[Show source]",
        "  C --> E[Inspect result]",
        "```",
        "",
        "```chart",
        chart.trimEnd(),
        "```",
      ].join("\n");
      const fixtureFile = path.join(configDir, "fixture.txt");
      writeFileSync(
        fixtureFile,
        // Fenced, so the prompt itself renders as one plain code block and every
        // rich block the test finds below comes from the agent's reply.
        `Reply with exactly the Markdown inside the four-backtick block below, character for character, without the surrounding four-backtick fence, and nothing else. Do not use tools.\n\n\`\`\`\`text\n${fixture}\n\`\`\`\`\n`,
      );
      // The previous turn may still be finishing (providers that cannot report
      // completion are only known to have published); retry while it is busy.
      stage("fixture-prompt");
      let prompted = cli(configDir, [
        "session",
        "prompt",
        sessionId,
        "--prompt-file",
        fixtureFile,
        ...(COMPLETION_QUALIFIED.has(provider) ? ["--wait", "--timeout", "10m"] : []),
        "--request-id",
        `rich-live:${suffix}:fixture`,
      ]);
      for (let attempt = 0; attempt < 40 && !prompted.ok && !prompted.receipt; attempt++) {
        await page.waitForTimeout(15_000);
        prompted = cli(configDir, [
          "session",
          "prompt",
          sessionId,
          "--prompt-file",
          fixtureFile,
          ...(COMPLETION_QUALIFIED.has(provider) ? ["--wait", "--timeout", "10m"] : []),
          "--request-id",
          `rich-live:${suffix}:fixture`,
        ]);
      }
      if (COMPLETION_QUALIFIED.has(provider)) {
        expect(prompted.ok, JSON.stringify((prompted as { error?: unknown }).error)).toBe(true);
      } else {
        expect(
          prompted.receipt,
          JSON.stringify((prompted as { error?: unknown }).error),
        ).toBeTruthy();
      }

      stage("fixture-rendered");
      await openConversation(page, status.browserUrl!, environmentName, providerTab);
      for (const kind of ["callout", "details", "table", "mermaid", "chart"]) {
        await expect(page.locator(`[data-rich-block="${kind}"]`).last(), kind).toBeVisible({
          timeout: COMPLETION_QUALIFIED.has(provider) ? 60_000 : 10 * 60_000,
        });
      }
      await expect(
        page.locator('[data-rich-block="chart"]').last().locator("figcaption"),
      ).toContainText("Inline chart from message text");

      stage("find-reveal");
      const disclosure = page.locator('[data-rich-block="details"]').last();
      const expanded = () =>
        disclosure.evaluate((element) =>
          element.querySelector("[aria-expanded]")?.getAttribute("aria-expanded"),
        );
      expect(await expanded()).toBe("false");
      await page.keyboard.press("Meta+f");
      if (!(await page.getByLabel("Find in chat").isVisible()))
        await page.keyboard.press("Control+f");
      const find = page.getByLabel("Find in chat");
      await find.fill("items.length");
      // The prompt quotes the fixture too; step to the agent's occurrence.
      for (let step = 0; step < 4 && (await expanded()) !== "true"; step++) {
        await find.press("Enter");
        await page.waitForTimeout(800);
      }
      expect(await expanded()).toBe("true");
      await find.press("Escape");
      await page.waitForTimeout(500);
      expect(await expanded()).toBe("false");

      stage("layout-390");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(800);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
      const chartCard = page.locator('[data-rich-block="chart"]').last();
      await chartCard.scrollIntoViewIfNeeded();
      const outside = await chartCard.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll('[role="toolbar"] button')).filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.right > bounds.right + 0.5 || rect.left < bounds.left - 0.5;
        }).length;
      });
      expect(outside).toBe(0);
    } finally {
      if (environment)
        cli(configDir, ["environment", "delete", environment, "--wait", "deleted"], 5 * 60_000);
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
