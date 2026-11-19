import { describe, expect, test } from "bun:test";
import { ALL_MACHINES } from "@/lib/federation/aggregate";
import { THIS_MACHINE } from "@/lib/project-search";
import { COMMAND_CATALOG } from "./catalog";
import { paletteMachine } from "./context";
import { nextPaletteFilter, filterShowsGroup, type CommandTarget } from "./model";
import { localContext, machineView } from "./palette.test-fixtures";
import {
  commandInMachineScope,
  noteRecentCommand,
  PALETTE_COMMAND_LIMIT,
  RECENT_COMMAND_LIMIT,
  searchCommands,
} from "./search";
import { moveActiveRow, resolveActiveRow } from "./selection";

const ids = (rows: { command: { id: string } }[]) => rows.map((row) => row.command.id);

describe("searchCommands", () => {
  test("an empty query suggests the context's runnable actions, nothing unavailable", () => {
    const results = searchCommands({
      query: "",
      filter: "all",
      commands: COMMAND_CATALOG,
      context: localContext(),
      recentCommandIds: [],
    });
    expect(ids(results.actions)).toEqual([
      "environment.open-changes",
      "environment.new-agent-tab",
      "environment.stop",
      "project.new-environment",
    ]);
    expect(results.settings).toEqual([]);
    expect(results.actions.every((row) => row.availability.available)).toBe(true);
  });

  test("recent commands lead, newest first", () => {
    const results = searchCommands({
      query: "",
      filter: "all",
      commands: COMMAND_CATALOG,
      context: localContext(),
      recentCommandIds: ["app.keyboard-shortcuts", "environment.stop"],
    });
    expect(ids(results.actions).slice(0, 2)).toEqual([
      "app.keyboard-shortcuts",
      "environment.stop",
    ]);
    expect(results.actions[0]?.recent).toBe(true);
  });

  test("matches labels and curated aliases, not target names", () => {
    const context = localContext();
    const preview = searchCommands({
      query: "preview",
      filter: "all",
      commands: COMMAND_CATALOG,
      context,
      recentCommandIds: [],
    });
    expect(ids(preview.settings)).toEqual(["settings.previews"]);
    // "build-modal-steps" is the target's name; no command matches on it.
    const byTarget = searchCommands({
      query: "build-modal-steps",
      filter: "all",
      commands: COMMAND_CATALOG,
      context,
      recentCommandIds: [],
    });
    expect(byTarget.actions).toEqual([]);
    const diff = searchCommands({
      query: "diff",
      filter: "all",
      commands: COMMAND_CATALOG,
      context,
      recentCommandIds: [],
    });
    expect(ids(diff.actions)).toEqual(["environment.open-changes"]);
  });

  test("unavailable matches stay discoverable, after the available ones", () => {
    const context = localContext({
      selection: { nodeId: null, projectId: null, environmentId: null },
    });
    const results = searchCommands({
      query: "open",
      filter: "actions",
      commands: COMMAND_CATALOG,
      context,
      recentCommandIds: [],
    });
    const changes = results.actions.find((row) => row.command.id === "environment.open-changes");
    expect(changes?.availability).toMatchObject({ available: false, code: "no-environment" });
    const firstUnavailable = results.actions.findIndex((row) => !row.availability.available);
    expect(
      results.actions.slice(firstUnavailable).every((row) => !row.availability.available),
    ).toBe(true);
  });

  test("a category filter lists its whole group on an empty query", () => {
    const results = searchCommands({
      query: "",
      filter: "settings",
      commands: COMMAND_CATALOG,
      context: localContext(),
      recentCommandIds: [],
    });
    expect(results.actions).toEqual([]);
    expect(ids(results.settings)).toContain("settings.environment");
    expect(ids(results.settings)).toContain("settings.network");
    expect(ids(results.settings)).not.toContain("settings.schedules");
    // The whole group, past the per-query limit: every enabled section and both scoped ones.
    expect(results.settings.length).toBeGreaterThan(PALETTE_COMMAND_LIMIT);
  });

  test("the machine filter narrows commands by their target's machine", () => {
    const mbp3 = paletteMachine(machineView("bk_mbp3", "mbp3", [], []));
    const studio = paletteMachine(machineView("bk_self", "studio", [], [], { bound: true }));
    const window: CommandTarget = { machine: null, project: null, environment: null };
    const remote: CommandTarget = { ...window, machine: mbp3 };
    const own: CommandTarget = { ...window, machine: studio };
    expect(commandInMachineScope(window, ALL_MACHINES)).toBe(true);
    expect(commandInMachineScope(window, THIS_MACHINE)).toBe(true);
    expect(commandInMachineScope(window, "bk_mbp3")).toBe(false);
    expect(commandInMachineScope(remote, "bk_mbp3")).toBe(true);
    expect(commandInMachineScope(remote, THIS_MACHINE)).toBe(false);
    expect(commandInMachineScope(own, THIS_MACHINE)).toBe(true);
  });

  test("recents are bounded, deduplicated and newest first", () => {
    let recent: string[] = [];
    for (let index = 0; index < RECENT_COMMAND_LIMIT + 3; index += 1) {
      recent = noteRecentCommand(recent, `c${index}`);
    }
    recent = noteRecentCommand(recent, "c5");
    expect(recent).toHaveLength(RECENT_COMMAND_LIMIT);
    expect(recent[0]).toBe("c5");
    expect(new Set(recent).size).toBe(recent.length);
  });
});

describe("palette filters", () => {
  test("category order wraps both ways", () => {
    expect(nextPaletteFilter("all", 1)).toBe("projects");
    expect(nextPaletteFilter("environments", 1)).toBe("actions");
    expect(nextPaletteFilter("history", 1)).toBe("all");
    expect(nextPaletteFilter("all", -1)).toBe("history");
  });

  test("destination filters show only destinations", () => {
    expect(filterShowsGroup("projects", "destinations")).toBe(true);
    expect(filterShowsGroup("projects", "actions")).toBe(false);
    expect(filterShowsGroup("settings", "settings")).toBe(true);
    expect(filterShowsGroup("all", "history")).toBe(true);
  });
});

describe("palette selection", () => {
  test("keeps the chosen, then the pinned row while rows are inserted above it", () => {
    expect(resolveActiveRow(["a", "b"], null, null)).toBe("a");
    // A late answer inserts a row before the pinned one: Enter still opens "a".
    expect(resolveActiveRow(["late", "a", "b"], null, "a")).toBe("a");
    expect(resolveActiveRow(["late", "a", "b"], "b", "a")).toBe("b");
    // Only a vanished row moves the highlight, to the first row.
    expect(resolveActiveRow(["late", "b"], null, "a")).toBe("late");
    expect(resolveActiveRow([], "a", "a")).toBeNull();
    expect(resolveActiveRow(["a", "late"], "b", "a", true)).toBeNull();
  });

  test("moves by identity and clamps at both ends", () => {
    const rows = ["a", "b", "c"];
    expect(moveActiveRow(rows, "a", 1)).toBe("b");
    expect(moveActiveRow(rows, "c", 1)).toBe("c");
    expect(moveActiveRow(rows, "a", -1)).toBe("a");
    expect(moveActiveRow(rows, "gone", 1)).toBe("a");
    expect(moveActiveRow([], null, 1)).toBeNull();
  });
});
