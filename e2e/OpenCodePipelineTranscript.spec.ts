import { expect, test } from "@playwright/test";
import { normalizeOpenCodeDisplayEntries } from "../apps/backend/src/core/opencode-display-transcript";

// Provider envelopes as persisted by build stages and Multi Review reviewers.
const raw = [
  {
    info: {
      id: "oc-pipeline",
      role: "assistant",
      time: { created: 1_800_000_000_000 },
      providerID: "opencode-go",
      modelID: "deepseek-v4-flash",
      serverOnlyMarker: "RAW_ENVELOPE_ONLY",
    },
    parts: [
      { id: "thinking", type: "reasoning", text: "Inspecting the build evidence" },
      {
        id: "tool",
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          title: "Run build checks",
          input: { command: "bun test" },
          output: "Checks passed\nBUILD_LOG_TAIL",
          time: { start: 1_800_000_000_000, end: 1_800_000_012_000 },
        },
      },
      { id: "text", type: "text", text: "The build and reviewer checks passed." },
    ],
  },
];

test("OpenCode pipeline/reviewer envelopes render as thinking and timed tool rows after backend normalization", async ({
  page,
}) => {
  // Execute the production backend normalizer in the server context, then send
  // its actual JSON boundary to the production renderer adapter/components.
  const display = normalizeOpenCodeDisplayEntries(raw);
  expect(JSON.stringify(display)).not.toContain("RAW_ENVELOPE_ONLY");
  expect(display).toHaveLength(raw.length);
  expect(display[0]).not.toHaveProperty("info");
  await page.route("**/fixture-opencode-display-transcript", (route) =>
    route.fulfill({ json: display }),
  );
  await page.goto("/opencode-pipeline-transcript");
  const transcript = page.getByRole("region", { name: "Pipeline transcript" });
  await expect(
    transcript.getByText("The build and reviewer checks passed.", { exact: true }),
  ).toBeVisible();
  await expect(transcript.getByText("Thinking", { exact: true })).toBeVisible();
  await expect(transcript.getByTitle("Ran for 12s")).toBeVisible();
  await expect(transcript.getByText("RAW_ENVELOPE_ONLY")).toHaveCount(0);
  await transcript.getByRole("button", { name: /Run Command bun test/ }).click();
  await expect(transcript.getByText(/BUILD_LOG_TAIL/)).toBeVisible();
  await page.getByRole("button", { name: "Switch transcript" }).click();
  await expect(page.getByText("Another tab")).toBeVisible();
  await page.getByRole("button", { name: "Switch transcript" }).click();
  await expect(transcript.getByTitle("Ran for 12s")).toBeVisible();
  await page.reload();
  await expect(
    transcript.getByText("The build and reviewer checks passed.", { exact: true }),
  ).toBeVisible();
  await expect(transcript.getByTitle("Ran for 12s")).toBeVisible();
});
