import path from "node:path";
import { expect, test as base, type Page } from "@playwright/test";
import {
  startInteractionFixtureHost,
  stopInteractionFixtureHost,
} from "./interaction-fixture-host";

const test = base.extend<{ recordingNode: string }>({
  recordingNode: async ({ baseURL }, use) => {
    const host = await startInteractionFixtureHost(
      path.join(import.meta.dirname, "fixture/cursor-screen-recording-node.ts"),
      { RECORDING_FIXTURE_RENDERER_ORIGIN: baseURL! },
    );
    try {
      await use(host.origin);
    } finally {
      await stopInteractionFixtureHost(host);
    }
  },
});

const preview = (name: string) =>
  path.resolve(`output/visual-previews/${name}-${test.info().project.name}.png`);

function recordingReads(page: Page) {
  const reads: { url: string; command: string; args: Record<string, unknown> }[] = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/__orkestrator/invoke") || request.method() !== "POST") return;
    const { command, args } = request.postDataJSON();
    if (command === "read_file_base64" || command === "read_container_file_base64") {
      reads.push({ url: request.url(), command, args });
    }
  });
  return reads;
}

async function playRecording(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Load video" }).click();
  const video = dialog.locator("video");
  await expect(video).toBeVisible();
  await video.evaluate((element) => (element as HTMLVideoElement).play());
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0);
}

test("bridge-generated host recordings play lazily and show a real remote read refusal", async ({
  page,
  recordingNode,
}) => {
  const reads = recordingReads(page);
  const invokeUrl = `${recordingNode}/__orkestrator/invoke`;
  await page.goto(`/cursor-screen-recording?owner=${encodeURIComponent(recordingNode)}`);
  const region = page.getByRole("region", { name: "Recordings" });
  const saved = region.getByRole("button", { name: "Preview file: checkout.png.mp4 (Video)" });
  await expect(saved).toBeVisible();
  await expect(region.getByRole("button", { name: /^Preview file:/ })).toHaveCount(2);
  await region.getByText("Discard screen recording").click();
  await expect(region).toContainText("Recording discarded. No video was kept.");
  await region.getByText("Save screen recording").first().click();
  await expect(region).toContainText("Recording saved (1.0 s)");
  await saved.click();
  await expect(page.getByRole("button", { name: "Load video" })).toBeVisible();
  expect(reads).toEqual([]);

  await playRecording(page);
  expect(reads).toEqual([
    {
      url: invokeUrl,
      command: "read_file_base64",
      args: {
        filePath: expect.stringMatching(
          /\/allowed-workspace\/ shots\.png\/run#2\/checkout\.png\.mp4$/,
        ),
      },
    },
  ]);
  await page.screenshot({ path: preview("cursor-recording-playing-verified") });

  await page.keyboard.press("Escape");
  await region.getByRole("button", { name: "Preview file: settings.mp4 (Video)" }).click();
  await page.getByRole("button", { name: "Load video" }).click();
  await expect(page.getByRole("dialog")).toContainText("outside previewable workspace storage");
  expect(reads).toHaveLength(2);
  expect(reads[1]).toEqual({
    url: invokeUrl,
    command: "read_file_base64",
    args: { filePath: expect.stringMatching(/\/outside-workspace\/settings\.mp4$/) },
  });
  await page.screenshot({ path: preview("cursor-recording-remote-refusal-verified") });

  await page.reload();
  await expect(saved).toBeVisible();
  expect(reads).toHaveLength(2);
});

test("container recordings use the owning node and a workspace-relative path", async ({
  page,
  recordingNode,
}) => {
  const reads = recordingReads(page);
  await page.goto(`/cursor-screen-recording?container&owner=${encodeURIComponent(recordingNode)}`);
  const region = page.getByRole("region", { name: "Recordings" });
  await region.getByRole("button", { name: "Preview file: outside.mp4 (Video)" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("outside previewable workspace storage");
  await expect(dialog.getByRole("button", { name: "Load video" })).toHaveCount(0);
  expect(reads).toEqual([]);

  await page.keyboard.press("Escape");
  await region.getByRole("button", { name: "Preview file: settings.mp4 (Video)" }).click();
  await expect(dialog.getByRole("button", { name: "Load video" })).toBeVisible();
  expect(reads).toEqual([]);
  await playRecording(page);
  expect(reads).toEqual([
    {
      url: `${recordingNode}/__orkestrator/invoke`,
      command: "read_container_file_base64",
      args: { containerId: "fixture-container", filePath: " shots.png/run?3/settings.mp4" },
    },
  ]);
});
