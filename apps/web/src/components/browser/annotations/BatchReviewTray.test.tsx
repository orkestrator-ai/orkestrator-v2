import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useAnnotationUiTestBudget } from "@/test/web-annotation-harness";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WEB_ANNOTATION_LIMITS } from "@orkestrator/protocol/web-annotations";
import { fixtureCapture } from "@orkestrator/protocol/testing/web-annotations-fixtures";
import { resetWebAnnotationAssetsForTests } from "@/lib/web-annotations/assets";
import { resetWebAnnotationSyncForTests } from "@/lib/web-annotations/sync";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
} from "@/test/web-annotation-fakes";
import { AnnotationHarness, seedBrowserLayout } from "@/test/web-annotation-harness";
import { batchEvidenceBudget, evidenceState } from "./BatchReviewTray";

let backend: FakeWebAnnotationBackend;
let bus: ReturnType<typeof installFakeOrkestrator>;

describe("batch review tray", () => {
  useAnnotationUiTestBudget();
  beforeEach(() => {
    resetWebAnnotationSyncForTests();
    resetWebAnnotationAssetsForTests();
    window.localStorage.clear();
    bus = installFakeOrkestrator({ capture: createFakeCaptureApi().api });
    backend = new FakeWebAnnotationBackend("env-1").install();
  });
  afterEach(() => {
    cleanup();
    resetWebAnnotationSyncForTests();
    bus.restore();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("shows viewport, evidence state and remaining capacity per selected note", async () => {
    backend.seed({ id: "annotation-a", title: "First" });
    const stale = backend.seed({ id: "annotation-b", title: "Second" });
    backend.captures.set(stale.currentCaptureId, {
      ...backend.captures.get(stale.currentCaptureId)!,
      state: "stale",
      stateReason: "layout moved",
    });
    seedBrowserLayout({ open: true, filter: { scope: "all", state: "open" } });
    render(<AnnotationHarness />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Select note 1: First/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Select note 2: Second/ }));
    const tray = await screen.findByRole("region", { name: "Batch review" });
    await waitFor(() =>
      expect(within(tray).getAllByText(/Evidence: current|Evidence: stale/)).toHaveLength(2),
    );
    expect(within(tray).getByText(/Evidence: stale capture/)).toBeTruthy();
    const capacity = tray.querySelector("[data-batch-capacity]")!;
    expect(capacity.textContent).toContain(`of ${WEB_ANNOTATION_LIMITS.briefAttachments}`);
    expect(within(tray).getAllByText(/\d+×\d+/).length).toBeGreaterThan(0);
    // Excluding an item only changes this batch.
    fireEvent.click(within(tray).getByRole("checkbox", { name: /Include “Second”/ }));
    expect(within(tray).getByText(/1 of 2 selected notes included/)).toBeTruthy();
    expect(backend.annotations.get("annotation-b")?.state).toBe("open");
  });

  test("names the first item that would exceed the image limit", () => {
    const capture = fixtureCapture("element", {
      assetIds: ["a", "b", "c", "d"],
    });
    const items = Array.from({ length: 6 }, (_, index) => ({ id: `n${index}`, capture }));
    const budget = batchEvidenceBudget(items);
    expect(budget.images).toBe(24);
    expect(budget.overflowId).toBe("n5");
    expect(batchEvidenceBudget([{ id: "x", capture: undefined }]).unknown).toBe(1);
    expect(evidenceState({ targetKind: "legacy-unresolved" }, undefined)).toMatch(/imported/);
    expect(
      evidenceState(
        { targetKind: "element" },
        { ...capture, redaction: { ...capture.redaction, imageExcluded: true } },
      ),
    ).toMatch(/image excluded/);
  });

  test("summary assets are counted exactly, once per digest, without capture records", () => {
    const shared = { assetId: "a", digest: "sha256:aa", bytes: 4096 };
    const budget = batchEvidenceBudget([
      {
        id: "n1",
        capture: undefined,
        assets: [shared, { assetId: "b", digest: "sha256:bb", bytes: 1000 }],
      },
      // Another note with the same image (same digest) adds nothing.
      { id: "n2", capture: undefined, assets: [{ ...shared, assetId: "c" }] },
      { id: "n3", capture: undefined, assets: [] },
    ]);
    expect(budget).toMatchObject({
      images: 2,
      imageBytes: 5096,
      unknownImageBytes: 0,
      unknown: 0,
      overflowId: null,
    });
    const many = Array.from({ length: WEB_ANNOTATION_LIMITS.briefAttachments + 1 }, (_, n) => ({
      id: `m${n}`,
      capture: undefined,
      assets: [{ assetId: `x${n}`, digest: `sha256:${n}`, bytes: 1 }],
    }));
    expect(batchEvidenceBudget(many).overflowId).toBe(`m${WEB_ANNOTATION_LIMITS.briefAttachments}`);
  });

  test("remaining byte capacity counts measured images and note text", () => {
    const capture = fixtureCapture("element", { assetIds: ["a", "b"] });
    const budget = batchEvidenceBudget(
      [
        { id: "n1", capture, textBytes: 100 },
        { id: "n2", capture: undefined, textBytes: 50 },
      ],
      (assetId) => (assetId === "a" ? 2048 : undefined),
    );
    expect(budget.imageBytes).toBe(2048);
    expect(budget.unknownImageBytes).toBe(1);
    expect(budget.textBytes).toBe(150);
    expect(budget.unknown).toBe(1);
  });
});
