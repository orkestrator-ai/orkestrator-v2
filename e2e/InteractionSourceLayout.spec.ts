import { expect, test } from "@playwright/test";
import path from "node:path";
import { mkdir } from "node:fs/promises";

// The real card and application CSS, with a deterministic permission snapshot.
// codex-host enables the fixture's remember-rule callback; provider stays Claude.
test("MCP source wraps above the remember panel and survives reload", async ({ page }, info) => {
  const name = `fixture-${"long-server-name-".repeat(13)}`;
  await page.route("**/__claude-test/snapshot?**", (route) =>
    route.fulfill({
      json: {
        activity: "waiting",
        snapshot: {
          version: 1,
          sessionId: "codex-host",
          revision: 1,
          requests: [
            {
              version: 1,
              id: "source-layout",
              provider: "claude",
              kind: "permission",
              origin: "interactive-native",
              sessionId: "codex-host",
              state: "pending",
              revision: 1,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              expiresAt: Date.now() + 300_000,
              source: { kind: "mcp-server", name, scope: "constructor" },
              presentation: {
                title: "Allow fixture tool",
                body: "Tool: mcp__fixture__read",
                questions: [],
                ruleOffer: { kind: "command-prefix", patterns: ["fixture read"], suggested: 0 },
              },
            },
          ],
        },
      },
    }),
  );
  await page.goto("/claude-interactions?session=codex-host");
  const source = page.getByTestId("interaction-source");
  await expect(source).toContainText(name);
  await expect(source).toContainText("from other configuration");
  await page.reload();
  await expect(source).toBeVisible();
  await page.getByRole("button", { name: "Approve and remember…", exact: true }).click();
  const panel = page.getByTestId("remember-rule-panel");
  await expect(panel).toBeVisible();
  const sourceBounds = (await source.boundingBox())!;
  const panelBounds = (await panel.boundingBox())!;
  expect(sourceBounds.y + sourceBounds.height).toBeLessThanOrEqual(panelBounds.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const nameBounds = (await source.getByTitle(name).boundingBox())!;
  expect(nameBounds.x).toBeGreaterThanOrEqual(0);
  expect(nameBounds.x + nameBounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const directory = path.resolve("output/visual-previews");
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `mcp-source-reviewed-${info.project.name}.png`),
    fullPage: true,
  });
});
