import { describe, expect, test } from "bun:test";
import type { SettingSourcesLayers, SettingSourcesRead } from "@/lib/portal/command-node-config";
import type { GlobalConfig } from "@/types";
import { settingDescriptor, SETTINGS_CATALOG } from "./catalog";
import {
  describeSource,
  presentSetting,
  resolveSettingSource,
  settingsSharingKey,
} from "./provenance";

const ok = (storedKeys: string[], inheritedKeys: string[] | null = null): SettingSourcesRead => ({
  status: "ok",
  sources: { storedKeys, inheritedKeys },
});
const names = { machine: "Laptop", commandNode: "Studio" };
const global = (values: Partial<GlobalConfig>) => values as GlobalConfig;

describe("resolveSettingSource", () => {
  test("a machine setting on a separate machine comes from that machine or the default", () => {
    const layers: SettingSourcesLayers = { commandNode: ok(["debugLogging"]), node: ok([]) };
    expect(resolveSettingSource("debugLogging", layers)).toEqual({ kind: "default" });
    expect(
      resolveSettingSource("debugLogging", { commandNode: ok([]), node: ok(["debugLogging"]) }),
    ).toEqual({ kind: "machine" });
  });

  test("an inherited preference on a separate machine comes from the command node", () => {
    const layers: SettingSourcesLayers = {
      commandNode: ok(["autoSteer"]),
      node: ok(["autoSteer"]),
    };
    expect(resolveSettingSource("autoSteer", layers)).toEqual({ kind: "command-node" });
    expect(
      resolveSettingSource("autoSteer", { commandNode: ok([]), node: ok(["autoSteer"]) }),
    ).toEqual({ kind: "default" });
  });

  test("on the command node itself an inherited preference is its own, handed down", () => {
    expect(
      resolveSettingSource("autoSteer", { commandNode: ok(["autoSteer"]), node: null }),
    ).toEqual({ kind: "command-node-self" });
    expect(
      resolveSettingSource("autoSteer", {
        commandNode: ok([], ["autoSteer"]),
        node: null,
      }),
    ).toEqual({ kind: "controller" });
  });

  test("an older backend, a failed read and a pending read stay unknown", () => {
    expect(resolveSettingSource("debugLogging", null)).toEqual({
      kind: "unknown",
      reason: "loading",
    });
    expect(
      resolveSettingSource("debugLogging", { commandNode: { status: "unsupported" }, node: null }),
    ).toEqual({ kind: "unknown", reason: "unsupported" });
    expect(
      resolveSettingSource("debugLogging", {
        commandNode: ok([]),
        node: { status: "failed", message: "offline" },
      }),
    ).toEqual({ kind: "unknown", reason: "failed" });
  });
});

describe("presentSetting", () => {
  const debug = settingDescriptor("debug.save-logs")!;

  test("an explicit override equal to the default is still an override", () => {
    const presentation = presentSetting(debug, global({ debugLogging: false }), {
      commandNode: ok(["debugLogging"]),
      node: null,
    })!;
    expect(presentation.hasOverride).toBe(true);
    expect(presentation.isDifferentFromDefault).toBe(false);
    expect(presentation.resettable).toBe(true);
  });

  test("a value that differs from the default without being stored is told apart", () => {
    const presentation = presentSetting(debug, global({ debugLogging: true }), {
      commandNode: ok([]),
      node: null,
    })!;
    expect(presentation.hasOverride).toBe(false);
    expect(presentation.isDifferentFromDefault).toBe(true);
  });

  test("override status is unknown when the source is", () => {
    const presentation = presentSetting(debug, global({ debugLogging: true }), {
      commandNode: { status: "unsupported" },
      node: null,
    })!;
    expect(presentation.hasOverride).toBeNull();
  });

  test("keys the backend always stores are not offered for reset", () => {
    const presentation = presentSetting(settingDescriptor("terminal.scrollback")!, global({}), {
      commandNode: ok(["terminalScrollback"]),
      node: null,
    })!;
    expect(presentation.resettable).toBe(false);
  });

  test("settings without a value binding have no presentation", () => {
    expect(presentSetting(settingDescriptor("claude.api-key")!, global({}), null)).toBeNull();
  });
});

describe("describing a source", () => {
  const autoSteer = settingDescriptor("general.auto-steer")!;
  test("names the machine or command node the value comes from", () => {
    expect(describeSource({ kind: "command-node" }, names, autoSteer)).toBe(
      "Inherited from Studio",
    );
    expect(describeSource({ kind: "machine" }, names, autoSteer)).toBe("Set on Laptop");
    expect(describeSource({ kind: "default" }, names, autoSteer)).toBe(
      "Default; nothing stored on Studio",
    );
    expect(describeSource({ kind: "unknown", reason: "unsupported" }, names, autoSteer)).toContain(
      "older Orkestrator",
    );
  });

  test("a reset of a shared key lists every field it changes", () => {
    const sharing = settingsSharingKey(SETTINGS_CATALOG, settingDescriptor("terminal.font-size")!);
    expect(sharing.map((entry) => entry.id).sort()).toEqual([
      "terminal.background-color",
      "terminal.font-family",
      "terminal.font-size",
    ]);
  });
});
