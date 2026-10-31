import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { SettingsPageLayout, SettingsRow, SettingsSectionHeader } from "./SettingsPageLayout";

const COMPONENTS_DIR = path.resolve(import.meta.dirname, "..");

/** Everything the settings shell renders: this folder and the two dialogs outside it. */
function settingsSources(): string[] {
  const settings = readdirSync(import.meta.dirname, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".tsx") && !file.includes(".test."))
    .filter((file) => file !== "SettingsPageLayout.tsx")
    .map((file) => path.join(import.meta.dirname, file));
  return [
    ...settings,
    path.join(COMPONENTS_DIR, "environments/EnvironmentSettingsDialog.tsx"),
    path.join(COMPONENTS_DIR, "docker/DockerStatsDialog.tsx"),
  ];
}

/** Class strings that size or center a page themselves instead of using the layout. */
function pageLevelContainers(source: string): string[] {
  const classStrings = source.match(/"[^"\n]*\bmax-w-[2-7]xl\b[^"\n]*"/g) ?? [];
  return classStrings.filter((value) => /\bmx-auto\b|\bspace-y-\d/.test(value));
}

afterEach(cleanup);

describe("SettingsPageLayout", () => {
  test("is left aligned at the default width, and wider only when asked", () => {
    const { rerender } = render(<SettingsPageLayout data-testid="page">Body</SettingsPageLayout>);
    const page = () => screen.getByTestId("page");
    expect(page().className).toContain("max-w-3xl");
    expect(page().className).not.toContain("mx-auto");

    rerender(
      <SettingsPageLayout data-testid="page" width="wide">
        Body
      </SettingsPageLayout>,
    );
    expect(page().className).toContain("max-w-5xl");
    expect(page().className).not.toContain("mx-auto");
  });

  test("draws the title, description and actions in the header", () => {
    render(
      <SettingsPageLayout
        title="Sounds"
        description="Distinct cues."
        actions={<button type="button">Add</button>}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Sounds" })).toBeTruthy();
    expect(screen.getByText("Distinct cues.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });

  test("leaves the header out when a page has no title", () => {
    render(<SettingsPageLayout>Body</SettingsPageLayout>);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("settings sections and rows", () => {
  test("a section heading sits under the page title, with its description", () => {
    render(
      <SettingsSectionHeader title="Credentials">Each has its own token.</SettingsSectionHeader>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Credentials" })).toBeTruthy();
    expect(screen.getByText("Each has its own token.")).toBeTruthy();
  });

  test("a row keeps its controls beside its label and description", () => {
    render(
      <SettingsRow label="Agent stopped" description="Play a cue.">
        <button type="button">Preview</button>
      </SettingsRow>,
    );
    expect(screen.getByText("Agent stopped")).toBeTruthy();
    expect(screen.getByText("Play a cue.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
  });
});

describe("page-level layout guard", () => {
  test("recognises a page that centers or sizes itself", () => {
    expect(pageLevelContainers('<div className="mx-auto max-w-3xl space-y-6 pb-8">')).toHaveLength(
      1,
    );
    expect(pageLevelContainers('<div className="max-w-2xl space-y-6">')).toHaveLength(1);
    expect(pageLevelContainers('<p className="mt-1 max-w-2xl text-xs">')).toHaveLength(0);
    expect(pageLevelContainers('<Icon className="mx-auto mb-2 h-6 w-6" />')).toHaveLength(0);
  });

  test("no settings page centers or sizes itself instead of using SettingsPageLayout", () => {
    const offenders = settingsSources().flatMap((file) =>
      pageLevelContainers(readFileSync(file, "utf8")).map(
        (value) => `${path.relative(COMPONENTS_DIR, file)}: ${value}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
