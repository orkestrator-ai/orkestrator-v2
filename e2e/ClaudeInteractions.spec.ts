import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

let host: ChildProcess;
let origin: string;
test.beforeAll(async () => {
  host = spawn("bun", [path.join(import.meta.dirname, "fixtures/claude-interactions-host.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  origin = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Claude fixture startup timed out")), 20000);
    host.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("Claude fixture exited before readiness"));
    });
    // Bound diagnostic output; never carry a provider response into reports.
    let error = "";
    host.stderr!.on("data", (chunk) => {
      error = (error + String(chunk)).slice(-3000);
    });
    host.once("error", reject);
    const lines = createInterface({ input: host.stdout! });
    lines.on("line", (line) => {
      if (!line.startsWith("INTERACTION_FIXTURE_READY:")) return;
      clearTimeout(timeout);
      resolve(`http://127.0.0.1:${line.split(":")[1]}`);
    });
    host.once("exit", () => {
      if (error) console.error(error);
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

for (const mode of ["form", "url"] as const) {
  test(`Claude ${mode} card rehydrates after an inactive environment and reload, then answers and cancels`, async ({
    page,
    request,
  }) => {
    await page.route("**/__claude-test/**", async (route) => {
      const incoming = route.request();
      const url = new URL(incoming.url());
      const response = await request.fetch(
        `${origin}${url.pathname.replace("/__claude-test", "")}${url.search}`,
        { method: incoming.method(), data: incoming.postData() ?? undefined },
      );
      await route.fulfill({ response });
    });
    const { sessionId } = await (await request.post(`${origin}/start`)).json();
    await page.goto(`/claude-interactions?session=${sessionId}`);
    await page.getByRole("button", { name: "Switch environment", exact: true }).click();
    await request.post(`${origin}/raise?session=${sessionId}`, { data: { mode } });
    await expect
      .poll(
        async () =>
          (await (await request.get(`${origin}/snapshot?session=${sessionId}`)).json()).activity,
      )
      .toBe("waiting");
    await page.getByRole("button", { name: "Return to environment", exact: true }).click();
    const title = mode === "form" ? "fixture-server needs input" : "Sign in to fixture-server";
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (mode === "form")
      await page.getByRole("textbox", { name: "Team", exact: true }).fill("core");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await request.get(`${origin}/snapshot?session=${sessionId}`)).json()).result,
      )
      .toEqual(
        mode === "form" ? { action: "accept", content: { team: "core" } } : { action: "accept" },
      );
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);
    await request.post(`${origin}/raise?session=${sessionId}`, { data: { mode } });
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel turn", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await request.get(`${origin}/snapshot?session=${sessionId}`)).json()).stopped,
      )
      .toBe(true);
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  });
}

test("a paused Claude question stays paused across a reload, then resumes and answers", async ({
  page,
  request,
}) => {
  await page.route("**/__claude-test/**", async (route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    const response = await request.fetch(
      `${origin}${url.pathname.replace("/__claude-test", "")}${url.search}`,
      { method: incoming.method(), data: incoming.postData() ?? undefined },
    );
    await route.fulfill({ response });
  });
  const { sessionId } = await (await request.post(`${origin}/start`)).json();
  const snapshot = async () =>
    (await (await request.get(`${origin}/snapshot?session=${sessionId}`)).json()) as {
      snapshot: { requests: Array<{ hold?: { heldAt?: number }; expiresAt?: number }> };
      result?: unknown;
    };
  await page.goto(`/claude-interactions?session=${sessionId}`);
  await request.post(`${origin}/raise?session=${sessionId}`, { data: { mode: "question" } });

  const pause = page.getByRole("button", { name: /^Pause countdown, \d:\d\d left$/ });
  await expect(pause).toBeVisible();
  await expect(pause).toHaveAttribute("aria-pressed", "false");
  await pause.click();

  // The bridge holds the deadline: its snapshot moves it out to the ceiling.
  await expect
    .poll(async () => (await snapshot()).snapshot.requests[0]?.hold?.heldAt !== undefined)
    .toBe(true);
  const ceiling = (await snapshot()).snapshot.requests[0]!.expiresAt!;
  expect(ceiling - Date.now()).toBeGreaterThan(23 * 60 * 60_000);

  // A reload (or another client) rehydrates the pause from the bridge.
  await page.reload();
  const resume = page.getByRole("button", { name: "Resume countdown", exact: true });
  await expect(resume).toBeVisible();
  await expect(resume).toHaveAttribute("aria-pressed", "true");
  await expect(resume).toHaveText("Paused");
  await page.screenshot({ path: test.info().outputPath("paused-question.png") });

  await resume.click();
  await expect(
    page.getByRole("button", { name: /^Pause countdown, [45]:\d\d left$/ }),
  ).toBeVisible();
  await expect
    .poll(async () => (await snapshot()).snapshot.requests[0]?.hold?.heldAt === undefined)
    .toBe(true);

  await page.getByRole("button", { name: "Core" }).click();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect
    .poll(async () => ((await snapshot()).result as { behavior?: string } | undefined)?.behavior)
    .toBe("allow");
});
