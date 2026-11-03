import { expect, test } from "@playwright/test";
import path from "node:path";

test("question shortcut keeps focus through advancement and ignores IME confirmation", async ({
  page,
}, testInfo) => {
  let resolution: unknown;
  const interaction = {
    version: 1,
    id: "shortcut-question",
    provider: "claude",
    kind: "question",
    origin: "interactive-native",
    sessionId: "shortcut-fixture",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    presentation: {
      title: "Choose the runtime",
      questions: [
        {
          id: "language",
          prompt: "Which language?",
          required: true,
          multiple: false,
          secret: false,
          allowFreeText: false,
          options: [{ id: "typescript", label: "TypeScript", providerValue: "TypeScript" }],
        },
        {
          id: "runtime",
          prompt: "Which runtime?",
          required: true,
          multiple: false,
          secret: false,
          allowFreeText: true,
          options: [],
        },
      ],
    },
  };
  await page.route("**/__claude-test/**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/resolve")) {
      resolution = route.request().postDataJSON();
      await route.fulfill({
        json: {
          result: "applied",
          interactionId: interaction.id,
          sessionId: interaction.sessionId,
          revision: 2,
        },
      });
    } else {
      await route.fulfill({
        json: {
          snapshot: { requests: resolution ? [] : [interaction] },
          activity: resolution ? "idle" : "waiting",
        },
      });
    }
  });
  await page.goto("/claude-interactions?session=shortcut-fixture");
  const option = page.getByRole("button", { name: "TypeScript" });
  await option.focus();
  await page.keyboard.press("Space");
  // Captures the real component before advancing, with keyboard focus visible.
  await page.screenshot({
    path: path.resolve(
      "output/visual-previews",
      `question-before-advance-${testInfo.project.name}.png`,
    ),
  });
  await option.dispatchEvent("keydown", {
    key: "Enter",
    metaKey: true,
    keyCode: 229,
    isComposing: false,
  });
  await expect(option).toBeFocused();
  await expect(page.getByText("Which runtime?", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Meta+Enter");
  const field = page.getByRole("textbox", { name: "Which runtime? response" });
  await expect(field).toBeFocused();
  await page.keyboard.type("Bun");
  await field.dispatchEvent("keydown", {
    key: "Enter",
    ctrlKey: true,
    keyCode: 229,
    isComposing: false,
  });
  expect(resolution).toBeUndefined();
  await page.screenshot({
    path: path.resolve(
      "output/visual-previews",
      `question-after-advance-${testInfo.project.name}.png`,
    ),
  });
  await page.keyboard.press("Control+Enter");
  await expect
    .poll(() => resolution)
    .toMatchObject({
      action: "answer",
      answer: {
        answers: [
          { questionId: "language", optionIds: ["typescript"] },
          { questionId: "runtime", freeText: "Bun" },
        ],
      },
    });
});
