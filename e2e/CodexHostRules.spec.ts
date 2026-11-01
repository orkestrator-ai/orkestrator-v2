import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

let host: ChildProcess;
let origin: string;
test.beforeAll(async () => {
  host = spawn("bun", [path.join(import.meta.dirname, "fixtures/codex-host-rules-host.ts")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("host fixture startup timed out")), 20_000);
    host.once("error", reject);
    host.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("host fixture exited"));
    });
    createInterface({ input: host.stdout! }).once("line", (line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
});
test.afterAll(async () => {
  if (!host || host.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    host.once("exit", () => resolve());
    host.kill();
  });
});

test("managed-network card remembers a host, auto-answers and asks after removal", async ({
  page,
  request,
}) => {
  await page.route("**/__claude-test/**", async (route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    const response = await request.fetch(`${origin}${url.pathname.replace("/__claude-test", "")}`, {
      method: incoming.method(),
      data: incoming.postData() ?? undefined,
    });
    await route.fulfill({ response });
  });
  await request.post(`${origin}/raise`);
  await page.goto("/claude-interactions?session=codex-host");
  await expect(page.getByText("Approve network access", { exact: true })).toBeVisible();
  await expect(page.getByText("Network host: registry.npmjs.org", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Approve and remember…", exact: true }).click();
  const panel = page.getByTestId("remember-rule-panel");
  await expect(panel).toContainText("registry.npmjs.org");
  await panel.getByRole("button", { name: "Approve and remember", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "Switch environment", exact: true }).click();
  await request.post(`${origin}/raise`);
  const state = await (await request.get(`${origin}/snapshot`)).json();
  expect(state.rules[0].useCount).toBe(1);
  expect(state.wireResponses).toEqual([
    { result: { decision: "accept" } },
    { result: { decision: "accept" } },
  ]);
  await page.getByRole("button", { name: "Return to environment", exact: true }).click();
  await expect(page.getByText("Approve network access", { exact: true })).toHaveCount(0);
  await request.post(`${origin}/remove`);
  await request.post(`${origin}/raise`);
  await expect(page.getByText("Approve network access", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve and remember…", exact: true }),
  ).toBeVisible();
});
