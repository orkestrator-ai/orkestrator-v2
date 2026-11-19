import { describe, expect, test } from "bun:test";
import { SETTINGS_CATALOG } from "./catalog";
import { searchSettings, searchTerms } from "./search";

const ids = (query: string) => searchSettings(SETTINGS_CATALOG, query).map((r) => r.descriptor.id);

describe("settings search", () => {
  test("an empty or punctuation-only query matches nothing", () => {
    expect(searchSettings(SETTINGS_CATALOG, "")).toEqual([]);
    expect(searchSettings(SETTINGS_CATALOG, "  ,; ")).toEqual([]);
  });

  test("finds a setting by its label first", () => {
    expect(ids("scrollback")[0]).toBe("terminal.scrollback");
    expect(ids("Auto-steer")[0]).toBe("general.auto-steer");
  });

  test("finds settings by curated aliases and says which alias matched", () => {
    const results = searchSettings(SETTINGS_CATALOG, "notifications");
    expect(results.map((r) => r.descriptor.id)).toContain("sounds.desktop-notifications");
    expect(results.map((r) => r.descriptor.id)).toContain("sounds.agent-question");
    const proxy = searchSettings(SETTINGS_CATALOG, "proxy")[0]!;
    expect(proxy.descriptor.id).toBe("network.allowed-domains");
    expect(proxy.matchedIn).toBe("alias");
    expect(proxy.matchedAlias).toBe("proxy");
  });

  test("every word has to match, and a phrase in the label ranks first", () => {
    expect(ids("review notifications")).toContain("sounds.desktop-notifications");
    expect(ids("terminal font size")[0]).toBe("terminal.font-size");
    expect(ids("scrollback zzzz")).toEqual([]);
  });

  test("finds conditionally unavailable settings too", () => {
    expect(ids("cron")).toContain("schedules.jobs");
    expect(ids("research servers")[0]).toBe("coordinator.research-servers");
  });

  test("is deterministic and ignores case and accents", () => {
    expect(ids("MODEL")).toEqual(ids("model"));
    expect(ids("modèl")).toEqual(ids("model"));
  });

  test("bounds and de-duplicates the query words", () => {
    expect(searchTerms("font font  size")).toEqual(["font", "size"]);
    expect(searchTerms("x".repeat(500)).join("").length).toBeLessThanOrEqual(120);
  });
});
