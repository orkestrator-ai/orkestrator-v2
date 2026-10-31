import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSync, visitorKeys, type Node } from "oxc-parser";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { SettingsPageLayout, SettingsRow, SettingsSectionHeader } from "./SettingsPageLayout";

const COMPONENTS_DIR = path.resolve(import.meta.dirname, "..");

/** Follow component imports so pages rendered from outside settings remain covered. */
function settingsSources(): string[] {
  const pending = [
    ...readdirSync(import.meta.dirname, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".tsx") && !file.includes(".test."))
      .map((file) => path.join(import.meta.dirname, file)),
    path.join(COMPONENTS_DIR, "environments/EnvironmentSettingsDialog.tsx"),
    path.join(COMPONENTS_DIR, "docker/DockerStatsDialog.tsx"),
  ];
  const sources = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (sources.has(file)) continue;
    sources.add(file);
    const { program, errors } = parseSync(file, readFileSync(file, "utf8"));
    expect(errors).toEqual([]);
    for (const node of program.body) {
      if (node.type !== "ImportDeclaration") continue;
      const specifier = node.source.value;
      const base = specifier.startsWith(".")
        ? path.resolve(path.dirname(file), specifier)
        : specifier.startsWith("@/components/")
          ? path.join(COMPONENTS_DIR, specifier.slice("@/components/".length))
          : null;
      if (!base?.startsWith(`${COMPONENTS_DIR}/`)) continue;
      if (Bun.file(`${base}.tsx`).size > 0) pending.push(`${base}.tsx`);
    }
  }
  return Array.from(sources).filter((file) => !file.endsWith("/SettingsPageLayout.tsx"));
}

/** Inspect complete class expressions, including cn arguments and template branches. */
function pageLevelContainers(source: string): string[] {
  const { program, errors } = parseSync("settings.tsx", source);
  expect(errors).toEqual([]);
  const offenders: string[] = [];
  function walk(node: Node): void {
    if (node.type === "JSXOpeningElement") {
      const tag = node.name.type === "JSXIdentifier" ? node.name.name : "";
      if (["div", "section", "main", "form"].includes(tag)) {
        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute" || attribute.name.name !== "className") continue;
          const value = source.slice(attribute.start, attribute.end);
          if (
            /\bmax-w-[2-7]xl\b/.test(value) &&
            /\bmx-auto\b|\bspace-y-|\bgap-(?:[xy]-)?/.test(value)
          )
            offenders.push(value);
        }
      }
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child) walk(child as Node);
      } else if (value) walk(value as Node);
    }
  }
  walk(program);
  return offenders;
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
    expect(
      pageLevelContainers('<div className="mx-auto max-w-3xl space-y-6 pb-8" />'),
    ).toHaveLength(1);
    expect(pageLevelContainers('<div className="max-w-2xl space-y-6" />')).toHaveLength(1);
    expect(pageLevelContainers('<p className="mt-1 max-w-2xl text-xs" />')).toHaveLength(0);
    expect(pageLevelContainers('<Icon className="mx-auto mb-2 h-6 w-6" />')).toHaveLength(0);
  });

  test("recognises split class arguments, template literals and alternative spacing", () => {
    for (const source of [
      `<div className={cn('max-w-2xl', 'space-y-4')} />`,
      '<section className={`max-w-3xl ${wide ? "gap-6" : "gap-y-4"}`} />',
      `<main className='mx-auto max-w-5xl' />`,
      `<div className={cn("max-w-4xl", compact && "gap-[12px]")} />`,
    ])
      expect(pageLevelContainers(source)).toHaveLength(1);
  });

  test("follows the environment preview services component", () => {
    expect(settingsSources()).toContain(
      path.join(COMPONENTS_DIR, "environments/EnvironmentPreviewServices.tsx"),
    );
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
