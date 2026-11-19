/**
 * Keeps the settings catalog honest against the settings it describes: every
 * setting the shared form owns is catalogued, every section has entries, and
 * every entry can still be found on its page (an anchor, an element id, an
 * accessible name or a heading that the settings source still contains).
 * It does not restate labels; it checks the catalog against the code.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createDefaultGlobalConfig } from "@orkestrator/protocol/app-config-defaults";
import { RESETTABLE_GLOBAL_SETTING_KEYS } from "@orkestrator/protocol/setting-sources";
import { SETTINGS_CATALOG } from "@/lib/settings-catalog/catalog";
import { formatSettingValue } from "@/lib/settings-catalog/provenance";
import { GLOBAL_SETTINGS_SECTIONS } from "@/lib/settings-navigation";
import type { GlobalConfig } from "@/types";
import { storedCoreFields } from "../GlobalSettings";

const SETTINGS_DIR = path.resolve(import.meta.dir, "..");
const EXTRA_SOURCES = [path.resolve(SETTINGS_DIR, "../docker/DockerSettings.tsx")];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith(".tsx") && !name.endsWith(".test.tsx") ? [full] : [];
  });
}

const SOURCE = [...sources(SETTINGS_DIR), ...EXTRA_SOURCES]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

/** Settings the form keeps that a person does not edit as a setting of their own. */
const NOT_CATALOGUED: Record<string, string> = {
  logDetailKeepRaised: "An option of Log detail, explained by that field.",
};

describe("settings catalog", () => {
  test("ids are unique and use the section.name form", () => {
    const ids = SETTINGS_CATALOG.map((descriptor) => descriptor.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z-]+\.[a-z0-9-]+$/);
  });

  test("every section has at least one entry, and entries name real sections", () => {
    const sections = new Set<string>(GLOBAL_SETTINGS_SECTIONS);
    const covered = new Set<string>(SETTINGS_CATALOG.map((descriptor) => descriptor.section));
    for (const descriptor of SETTINGS_CATALOG) expect(sections.has(descriptor.section)).toBe(true);
    // The legacy Skills deep link opens the Installed tab within Capabilities.
    expect([...sections].filter((section) => !covered.has(section))).toEqual(["skills"]);
  });

  test("every setting the shared form saves is catalogued with a value binding", () => {
    const formKeys = Object.keys(
      storedCoreFields(createDefaultGlobalConfig() as unknown as GlobalConfig),
    );
    const bound = new Set(SETTINGS_CATALOG.flatMap((descriptor) => descriptor.value?.key ?? []));
    const missing = formKeys.filter((key) => !bound.has(key as never) && !NOT_CATALOGUED[key]);
    expect(missing).toEqual([]);
  });

  test("every resettable key is reachable from some catalogued field", () => {
    const bound = new Set<string>(
      SETTINGS_CATALOG.flatMap((descriptor) => descriptor.value?.key ?? []),
    );
    expect(RESETTABLE_GLOBAL_SETTING_KEYS.filter((key) => !bound.has(key))).toEqual([]);
  });

  test("every entry can be found on its page", () => {
    const unreachable = SETTINGS_CATALOG.filter((descriptor) => {
      const suffix = descriptor.id.match(/^[a-z]+\.(mode|model|sign-in)$/)?.[1];
      if (
        suffix &&
        ["setting", "data-setting-anchor"].some((attribute) =>
          SOURCE.includes(`${attribute}={\`\${platform}.${suffix}\`}`),
        )
      )
        return false;
      if (
        SOURCE.includes(`setting="${descriptor.id}"`) ||
        SOURCE.includes(`data-setting-anchor="${descriptor.id}"`)
      ) {
        return false;
      }
      const locate = descriptor.locate;
      if (locate?.id && SOURCE.includes(`id="${locate.id}"`)) return false;
      if (locate?.ariaLabel && SOURCE.includes(`aria-label="${locate.ariaLabel}"`)) return false;
      const modelPicker = locate?.id === `agent-model-${descriptor.section}`;
      if (modelPicker && SOURCE.includes("id={`agent-model-${platform}`}")) return false;
      if (locate?.heading && SOURCE.includes(`title="${locate.heading}"`)) return false;
      return true;
    }).map((descriptor) => descriptor.id);
    expect(unreachable).toEqual([]);
  });

  test("a sensitive setting never has a value binding and never formats a value", () => {
    for (const descriptor of SETTINGS_CATALOG.filter((entry) => entry.sensitive)) {
      expect(descriptor.value).toBeUndefined();
      expect(formatSettingValue(descriptor, "sk-secret")).toBe("Hidden");
      expect(JSON.stringify(descriptor.aliases ?? [])).not.toMatch(/sk-ant-|ghp_/);
    }
  });

  test("availability rules point at catalogued settings", () => {
    const ids = new Set(SETTINGS_CATALOG.map((descriptor) => descriptor.id));
    for (const descriptor of SETTINGS_CATALOG) {
      const via = descriptor.availability?.via;
      if (via) expect(ids.has(via)).toBe(true);
    }
  });
});
