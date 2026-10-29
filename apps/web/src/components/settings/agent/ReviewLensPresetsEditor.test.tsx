import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import {
  REVIEW_LENS_PRESETS_MAX,
  SHIPPED_REVIEW_LENS_PRESETS,
  shippedReviewLensPresets,
  type ReviewLensPreset,
} from "@orkestrator/protocol/review-lens";
import { ReviewLensPresetsEditor, reviewLensPresetsError } from "./ReviewLensPresetsEditor";

afterEach(cleanup);

function Harness({
  initial,
  onChange,
}: {
  initial: ReviewLensPreset[];
  onChange: (presets: ReviewLensPreset[]) => void;
}) {
  const [presets, setPresets] = useState(initial);
  return (
    <ReviewLensPresetsEditor
      presets={presets}
      onChange={(next) => {
        setPresets(next);
        onChange(next);
      }}
    />
  );
}

function labels(): string[] {
  return within(screen.getByRole("list", { name: "Review focus presets" }))
    .getAllByRole("textbox", { name: /label$/ })
    .map((input) => (input as HTMLInputElement).value);
}

describe("ReviewLensPresetsEditor", () => {
  test("edits, deletes, reorders, adds and restores the shipped presets", () => {
    const onChange = mock((_presets: ReviewLensPreset[]) => undefined);
    render(<Harness initial={shippedReviewLensPresets()} onChange={onChange} />);
    expect(labels()).toEqual(SHIPPED_REVIEW_LENS_PRESETS.map((preset) => preset.label));
    const restore = screen.getByRole("button", { name: "Restore shipped presets" });
    expect((restore as HTMLButtonElement).disabled).toBe(true);

    // Edit
    fireEvent.change(screen.getByRole("textbox", { name: "Preset 1 instruction" }), {
      target: { value: "Only the auth module." },
    });
    expect(onChange.mock.calls.at(-1)?.[0][0]).toEqual({
      id: "security",
      label: "Security",
      instruction: "Only the auth module.",
    });
    // Delete
    fireEvent.click(screen.getByRole("button", { name: "Delete Performance" }));
    expect(labels()).not.toContain("Performance");
    // Reorder
    fireEvent.click(screen.getByRole("button", { name: "Move Maintainability up" }));
    expect(labels()).toEqual([
      "Security",
      "Tests and coverage",
      "Maintainability",
      "API and compatibility",
    ]);
    // Add
    fireEvent.click(screen.getByRole("button", { name: "Add preset" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Preset 5 label" }), {
      target: { value: "Migrations" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Preset 5 instruction" }), {
      target: { value: "Check both directions." },
    });
    const added = onChange.mock.calls.at(-1)![0];
    expect(added.at(-1)).toMatchObject({
      label: "Migrations",
      instruction: "Check both directions.",
    });
    expect(reviewLensPresetsError(added)).toBeNull();

    // Restore: the shipped five with their text, first, and the user's own kept.
    expect((restore as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(restore);
    const restored = onChange.mock.calls.at(-1)![0];
    expect(restored.slice(0, 5)).toEqual([...SHIPPED_REVIEW_LENS_PRESETS]);
    expect(restored.slice(5).map((preset) => preset.label)).toEqual(["Migrations"]);
  });

  test("reports invalid presets and caps the list", () => {
    const presets = Array.from({ length: REVIEW_LENS_PRESETS_MAX }, (_, index) => ({
      id: `p${index}`,
      label: `Preset ${index}`,
      instruction: "Look.",
    }));
    render(<Harness initial={presets} onChange={() => undefined} />);
    expect((screen.getByRole("button", { name: "Add preset" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Restoring would exceed the bound, so it is refused rather than dropping a preset.
    expect(
      (screen.getByRole("button", { name: "Restore shipped presets" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Preset 1 label" }), {
      target: { value: "x".repeat(65) },
    });
    expect(screen.getByText("A focus label can be at most 64 characters.")).toBeTruthy();
    expect(reviewLensPresetsError([{ id: "a", label: "", instruction: "x" }])).toContain(
      "Review focus preset 1",
    );
    expect(
      reviewLensPresetsError([...presets, { id: "x", label: "L", instruction: "I" }]),
    ).toContain("at most 20");
  });

  test("an empty list says launchers still accept a custom focus", () => {
    render(<Harness initial={[]} onChange={() => undefined} />);
    expect(screen.getByText("No presets. Launchers still accept a custom focus.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore shipped presets" }));
    expect(labels()).toEqual(SHIPPED_REVIEW_LENS_PRESETS.map((preset) => preset.label));
  });
});
