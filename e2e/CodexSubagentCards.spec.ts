/**
 * Codex sub-agent cards in the browser, over the real bridge and backend.
 *
 * The scenario of the duplicate-card incident — three path-only spawns that
 * succeed and one rejected at capacity — runs through a fake app-server, the
 * real codex-bridge process and the real backend projection
 * (`fixtures/codex-subagent-host.ts`). The page renders that projection the
 * way a Codex tab does. Each child must show exactly one card that keeps its
 * status as it runs and finishes, the rejected spawn must stay a failure that
 * is never counted as active, and the same cards must come back after a page
 * reload and after a cold restart of bridge and backend, with the nested
 * transcript still opening.
 *
 * The data-path half, which `mise run test` runs, is
 * `apps/backend/tests/codex-subagent-cards.test.ts`.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

const CHILDREN = [
  { name: "Ada", role: "explorer", task: "lint_check" },
  { name: "Grace", role: "explorer", task: "type_check" },
  { name: "Linus", role: "worker", task: "unit_check" },
] as const;

let host: ChildProcess;
let origin: string;

test.beforeAll(async () => {
  host = spawn("bun", [path.join(import.meta.dirname, "fixtures/codex-subagent-host.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  origin = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Codex fixture startup timed out")), 20_000);
    // Bounded diagnostics only; the fixture handles no real prompts.
    let error = "";
    host.stderr!.on("data", (chunk) => {
      error = (error + String(chunk)).slice(-3_000);
    });
    host.once("error", reject);
    host.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`Codex fixture exited before readiness\n${error}`));
    });
    createInterface({ input: host.stdout! }).on("line", (line) => {
      if (!line.startsWith("CODEX_SUBAGENT_FIXTURE_READY:")) return;
      clearTimeout(timeout);
      resolve(`http://127.0.0.1:${line.split(":")[1]}`);
    });
  });
});

test.afterAll(async () => {
  if (!host || host.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    host.once("exit", () => resolve());
    host.kill("SIGTERM");
  });
});

async function hostCall(
  request: APIRequestContext,
  action: string,
  stack: string,
): Promise<Record<string, unknown>> {
  const response = await request.post(`${origin}/${action}?stack=${stack}`, { timeout: 90_000 });
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.ok(), `${action}: ${String(body.error)}`).toBe(true);
  return body;
}

/** Every agent card on the page, one trigger each. */
const cardTriggers = (page: Page) => page.getByRole("button", { name: /^Agent / });

const card = (page: Page, label: string) =>
  page.getByRole("button", { name: new RegExp(`^Agent ${label.replace(/[()]/g, "\\$&")}`) });

async function expectCards(page: Page, childStatus: "Active" | "Finished") {
  await expect(cardTriggers(page)).toHaveCount(4);
  for (const child of CHILDREN) {
    const trigger = card(page, `${child.name} (${child.role})`);
    await expect(trigger).toHaveCount(1);
    await expect(trigger).toContainText(childStatus);
  }
  const rejected = card(page, "extra_check");
  await expect(rejected).toHaveCount(1);
  await expect(rejected).toContainText("Failed");
  // The rejected spawn never joins the active count.
  if (childStatus === "Active") {
    await expect(page.getByText("3 active", { exact: true })).toBeVisible();
  } else {
    await expect(page.getByText(/\d+ active/)).toHaveCount(0);
  }
}

/** Check the rendered placement, independently of status text and card counts. */
async function expectPinnedChildren(page: Page, phase: "running" | "finished" | "cold") {
  const rows = page.getByTestId("transcript-row");
  const children = CHILDREN.map((child) => card(page, `${child.name} (${child.role})`));
  const childRow = rows.filter({ has: children[0]! });
  await expect(childRow).toHaveCount(1);
  const placement = phase === "cold" ? childRow : rows.last();
  for (const child of CHILDREN) {
    await expect(
      placement.getByRole("button", { name: new RegExp(`^Agent ${child.name} `) }),
    ).toHaveCount(1);
  }
  if (phase === "running")
    await expect(childRow).toHaveAttribute("data-message-id", "active-agents");
  else await expect(page.locator('[data-message-id="active-agents"]')).toHaveCount(0);

  // The cards must be visually below the parent's text, not merely present in
  // a group somewhere in the DOM. Nested transcripts are outside this check.
  const intro = page.getByText("Starting the checks.", { exact: true });
  const introBox = await intro.boundingBox();
  const firstBox = await children[0]!.boundingBox();
  expect(introBox).not.toBeNull();
  expect(firstBox).not.toBeNull();
  expect(firstBox!.y).toBeGreaterThanOrEqual(introBox!.y + introBox!.height);

  if (phase !== "running") {
    const summary = page.getByText("All three checks passed; one more could not start.", {
      exact: true,
    });
    const summaryBox = await summary.boundingBox();
    expect(summaryBox).not.toBeNull();
    if (phase === "finished") {
      // Settled cards stay below the live response on refresh and page reload.
      expect(firstBox!.y).toBeGreaterThanOrEqual(summaryBox!.y + summaryBox!.height);
    } else {
      // Cold recovery has a separate final-response row (asserted by the
      // backend spec). Its cards remain with the preceding spawn response.
      const lastBox = await children.at(-1)!.boundingBox();
      expect(lastBox).not.toBeNull();
      expect(summaryBox!.y).toBeGreaterThanOrEqual(lastBox!.y + lastBox!.height);
    }
  }

  // Runtime is checked separately: a running child's label changes across reloads.
  const texts = await childRow
    .getByRole("button", { name: /^Agent (Ada|Grace|Linus) / })
    .allTextContents();
  return texts.map((text) => text.replace(/(?:\d+h )?(?:\d+m )?\d+(?:\.\d+)?m?s$/, ""));
}

/** Read only the runtime, independently of the card's identity, status and activity. */
async function childRuntimes(page: Page): Promise<number[]> {
  return Promise.all(
    CHILDREN.map(async (child) => {
      const runtime = card(page, `${child.name} (${child.role})`).getByText(
        /^(?:\d+h )?(?:\d+m )?\d+(?:\.\d+)?m?s$/,
      );
      await expect(runtime).toBeVisible();
      const text = (await runtime.textContent())!;
      const units: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001 };
      return Array.from(text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)).reduce(
        (seconds, match) => seconds + Number(match[1]) * units[match[2]!]!,
        0,
      );
    }),
  );
}

/** Opens a child's card and checks its nested transcript; a running child has no answer yet. */
async function expectNestedTranscript(
  page: Page,
  child: (typeof CHILDREN)[number],
  finished = true,
) {
  const trigger = card(page, `${child.name} (${child.role})`);
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator(`#${await trigger.getAttribute("aria-controls")}`);
  // The child's own command, from its rollout, then its answer once it has one.
  await expect(
    panel.getByRole("button", { name: `Exec Command echo ${child.task}`, exact: true }),
  ).toBeVisible();
  await expect(panel.getByText(`${child.task} passed.`, { exact: true })).toHaveCount(
    finished ? 1 : 0,
  );
}

test("Codex sub-agent cards stay one per child through reload and a cold restart", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await page.route("**/__codex-subagents/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await request.fetch(
      `${origin}${url.pathname.replace("/__codex-subagents", "")}${url.search}`,
      { timeout: 90_000 },
    );
    await route.fulfill({ response });
  });

  const { stack } = (await (await request.post(`${origin}/start`)).json()) as { stack: string };
  try {
    await hostCall(request, "prompt", stack);
    await page.goto(`/codex-subagent-cards?stack=${stack}`);

    // Running. The bridge probes child rollouts on its own cadence, so read
    // again until the backend serves all four cards.
    await expect(async () => {
      await page.getByRole("button", { name: "Refresh transcript", exact: true }).click();
      await expect(cardTriggers(page)).toHaveCount(4, { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByTestId("turn-phase")).toHaveText("running");
    await expectCards(page, "Active");
    const runningOrder = await expectPinnedChildren(page, "running");
    const runningRuntimes = await childRuntimes(page);
    await expectNestedTranscript(page, CHILDREN[0], false);

    await page.reload();
    await expectCards(page, "Active");
    expect(await expectPinnedChildren(page, "running")).toEqual(runningOrder);
    const reloadedRuntimes = await childRuntimes(page);
    for (let index = 0; index < CHILDREN.length; index += 1) {
      expect(reloadedRuntimes[index]!).toBeGreaterThanOrEqual(runningRuntimes[index]!);
    }
    await expect
      .poll(async () => (await childRuntimes(page))[0]!)
      .toBeGreaterThan(reloadedRuntimes[0]!);

    // The children finish while the page holds an old read and the backend
    // that served it is replaced, as for a tab in an inactive environment.
    await hostCall(request, "finish", stack);
    await hostCall(request, "reopen", stack);
    await expect(async () => {
      await page.getByRole("button", { name: "Refresh transcript", exact: true }).click();
      await expect(page.getByTestId("turn-phase")).toHaveText("idle", { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await expectCards(page, "Finished");
    const finishedOrder = await expectPinnedChildren(page, "finished");
    const finishedRuntimes = await childRuntimes(page);
    for (const duration of finishedRuntimes) expect(duration).toBeGreaterThan(0);
    await expectNestedTranscript(page, CHILDREN[0]);

    await page.reload();
    await expectCards(page, "Finished");
    expect(await expectPinnedChildren(page, "finished")).toEqual(finishedOrder);
    expect(await childRuntimes(page)).toEqual(finishedRuntimes);
    await expectNestedTranscript(page, CHILDREN[1]);

    // Cold: a new bridge, app-server and backend recover identity from disk.
    expect(await hostCall(request, "restart", stack)).toEqual({ bridgeGeneration: 2 });
    await page.reload();
    await expect(page.getByTestId("turn-phase")).toHaveText("idle");
    await expectCards(page, "Finished");
    expect(await expectPinnedChildren(page, "cold")).toEqual(finishedOrder);
    expect(await childRuntimes(page)).toEqual(finishedRuntimes);
    for (const child of CHILDREN) await expectNestedTranscript(page, child);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await request.post(`${origin}/close?stack=${stack}`);
  }
});
