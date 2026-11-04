import { expect, test } from "@playwright/test";

test("Claude pipeline retains reported child model through normalization and reload", async ({
  page,
}, testInfo) => {
  const parts = [
    {
      type: "tool-invocation",
      content: "Agent",
      toolName: "Agent",
      toolUseId: "toolu_agent",
      toolArgs: { description: "Survey repository", prompt: "Survey", model: "sonnet" },
      toolState: "success",
      subagentModelId: "claude-sonnet-4-6",
      subagentReasoningEffort: "high",
    },
  ];
  let includeModel = false;
  await page.route("**/fixture-opencode-display-transcript", (route) =>
    route.fulfill({
      json: [
        {
          id: "claude-pipeline",
          role: "assistant",
          content: "",
          parts: parts.map((part) => ({
            ...part,
            subagentModelId: includeModel ? part.subagentModelId : undefined,
            subagentReasoningEffort: includeModel ? part.subagentReasoningEffort : undefined,
          })),
        },
      ],
    }),
  );
  await page.goto("/opencode-pipeline-transcript?agent=claude");
  const transcript = page.getByRole("region", { name: "Pipeline transcript" });
  const trigger = transcript.getByRole("button", { name: /Agent Survey repository/ });
  await trigger.click();
  await page.screenshot({
    path: `output/visual-previews/pipeline-model-before-${testInfo.project.name}.png`,
  });
  includeModel = true;
  await page.reload();
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(transcript.getByText("claude-sonnet-4-6", { exact: true })).toBeVisible();
  await page.screenshot({
    path: `output/visual-previews/pipeline-model-after-${testInfo.project.name}.png`,
  });
  await page.getByRole("button", { name: "Switch transcript" }).click();
  await page.getByRole("button", { name: "Switch transcript" }).click();
  await expect(transcript.getByText("claude-sonnet-4-6", { exact: true })).toBeVisible();
});
