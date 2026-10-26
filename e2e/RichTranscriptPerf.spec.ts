import { expect, test } from "@playwright/test";
import type {} from "./fixture/RichTranscriptPerfFixture";

test("timer-less streams advance only on external ticks and stop accepting ticks after stop", async ({
  page,
}) => {
  // Install before navigation so every timer in the fixture shares this clock.
  await page.clock.install();
  await page.goto("/rich-transcript-perf");
  await expect.poll(() => page.evaluate(() => window.__richPerf?.ready)).toBe(true);
  const initial = await page.evaluate(() => ({
    messages: window.__richPerf!.messageCount(),
    ...window.__richPerf!.counters(),
  }));
  await page.evaluate(() => window.__richPerf!.startStream(0, 12));
  await expect
    .poll(() => page.evaluate(() => window.__richPerf!.messageCount()))
    .toBe(initial.messages + 1);
  await page.clock.runFor(500);
  expect(await page.evaluate(() => window.__richPerf!.counters().streamTicks)).toBe(
    initial.streamTicks,
  );

  await page.evaluate(() => {
    window.__richPerf!.streamTick();
    window.__richPerf!.streamTick();
    window.__richPerf!.streamTick();
  });
  expect(await page.evaluate(() => window.__richPerf!.counters())).toMatchObject({
    streamTicks: initial.streamTicks + 3,
    streamChars: initial.streamChars + 36,
  });
  // Multiple ticks in one browser task must accumulate in the rendered row.
  const row = page.locator('[data-chat-message-key^="perf-stream-"]').last();
  await expect(row).toContainText("Here is the generated module:");
  await expect(row).toContainText("export interface Sample999 {\n  id: s");

  await page.evaluate(() => {
    window.__richPerf!.stopStream();
    window.__richPerf!.streamTick();
  });
  await page.clock.runFor(500);
  expect(await page.evaluate(() => window.__richPerf!.counters().streamTicks)).toBe(
    initial.streamTicks + 3,
  );

  await page.evaluate(() => {
    window.__richPerf!.startStream(-1, 7);
    window.__richPerf!.streamTick();
  });
  await expect
    .poll(() => page.evaluate(() => window.__richPerf!.messageCount()))
    .toBe(initial.messages + 2);
  await page.clock.runFor(500);
  expect(await page.evaluate(() => window.__richPerf!.counters())).toMatchObject({
    streamTicks: initial.streamTicks + 4,
    streamChars: initial.streamChars + 43,
  });
  await page.evaluate(() => window.__richPerf!.stopStream());
});
