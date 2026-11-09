import { expect, test } from "@playwright/test";
import type { ChangeProjection } from "@orkestrator/protocol/change-resources";

for (const state of [
  "ready",
  "partial",
  "stale",
  "loading",
  "unavailable",
  "interrupted",
  "no-segment",
] as const) {
  test(`thread strip retains ${state} status and containment across reload`, async ({
    page,
  }, testInfo) => {
    const projection: ChangeProjection = {
      schemaVersion: 1,
      resourceKey: "thread-net/segment/seg-1/live",
      ownerGeneration: "gen-1",
      revision: 1,
      measurementId: "measurement-1",
      state: state === "interrupted" || state === "no-segment" ? "ready" : state,
      availability: "ready",
      observationState: "fresh",
      coverageState: state === "partial" ? "partial" : "complete",
      labelKey: "changes.scope.thread-net",
      labelArgs: {},
      hasFileChanges: state === "partial" ? null : false,
      hasTextChanges: false,
      badge: { visible: false, mode: "counts" },
      counters: {
        changedFiles: 0,
        additions: { value: 0, quality: "complete", bound: "exact" },
        deletions: { value: 0, quality: "complete", bound: "exact" },
      },
      reasonKeys:
        state === "interrupted"
          ? ["changes.reason.interrupted"]
          : state === "partial"
            ? ["changes.reason.omitted-unverified"]
            : [],
      provenanceLabelKey: "changes.provenance.observed",
      detail: null,
      filePage: null,
      actions: [],
      freshness: {
        lastAttemptAt: null,
        lastSuccessfulCheckAt: null,
        lastContentChangeObservedAt: null,
        observedAt: null,
        requiredObservationEpoch: null,
        checkedObservationEpoch: null,
      },
    };
    await page.exposeFunction("changesInvoke", (command: string) => {
      if (command === "changes_get_thread")
        return state === "no-segment"
          ? null
          : { segmentId: "seg-1", resourceKey: projection.resourceKey };
      if (command === "changes_get_view") return { kind: "projection", projection };
      if (command === "changes_get_history") return { kind: "page", entries: [], nextCursor: null };
      return null;
    });
    await page.goto("/change-tracking?header-only");
    const check = async () => {
      const containment = page.getByTestId("fixture-containment");
      await expect(containment).toBeVisible();
      if (state === "no-segment") {
        await expect(page.getByTestId("environment-containment-row")).toBeVisible();
        await expect(page.getByTestId("turn-changes-toggle")).toHaveCount(0);
        return;
      }
      const tag = page.getByTestId("change-state-tag");
      if (state !== "ready" || testInfo.project.name === "desktop-chromium") {
        await expect(tag).toBeVisible();
        const label =
          state === "interrupted"
            ? "Interrupted"
            : state === "ready"
              ? "Final"
              : state.charAt(0).toUpperCase() + state.slice(1);
        expect(await tag.ariaSnapshot()).toContain(label);
      } else await expect(tag).toBeHidden();
      if (state === "partial") await expect(page.getByText("No file changes")).toHaveCount(0);
      if (state === "ready") await expect(page.getByText("No file changes")).toBeVisible();
      const toggle = page.getByTestId("turn-changes-toggle");
      const [left, right] = await Promise.all([containment.boundingBox(), toggle.boundingBox()]);
      expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x);
      expect(right!.x + right!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      await toggle.focus();
      await expect(toggle).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
    };
    await check();
    await page.reload();
    await check();
    await page.screenshot({
      path: `output/visual-previews/thread-strip-${state}-${testInfo.project.name}.png`,
    });
  });
}
