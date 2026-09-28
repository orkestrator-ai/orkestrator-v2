import { describe, expect, mock, test } from "bun:test";
import {
  createSession,
  getSession,
  inspectDuringTurn,
  nextQueryCall,
  queryControlOverrides,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";
import { configureClaudeSession } from "./session-manager.js";
import {
  ultracodeFlagSetting,
  ultracodeRuntimeState,
  ultracodeUnavailableNotice,
} from "./ultracode.js";

/**
 * Ultracode is a flag-layer setting the CLI keeps for one process, and since
 * Claude Code 2.1.284 an effort change without an `ultracode` key turns it off.
 * These cases pin the three places the bridge has to hold it: the query each
 * turn starts, live settings changes, and the runtime read that tells the user
 * when the CLI declined it.
 */

describe("ultracodeFlagSetting", () => {
  test("an explicit toggle is sent as given", () => {
    expect(
      ultracodeFlagSetting({
        parameterValues: { ultracode: false },
        effortChanged: true,
        fastModeChanged: false,
        modelChanged: false,
        live: true,
      }),
    ).toEqual({ ultracode: false });
    expect(
      ultracodeFlagSetting({
        parameterValues: { ultracode: true },
        effortChanged: false,
        fastModeChanged: false,
        modelChanged: true,
        live: false,
      }),
    ).toEqual({ ultracode: true });
  });

  test("an effort change carries a live Ultracode along", () => {
    expect(
      ultracodeFlagSetting({
        effortChanged: true,
        fastModeChanged: false,
        modelChanged: false,
        live: true,
      }),
    ).toEqual({
      ultracode: true,
    });
  });

  test("a fast-mode change carries an applied Ultracode along", () => {
    expect(
      ultracodeFlagSetting({
        effortChanged: false,
        fastModeChanged: true,
        modelChanged: false,
        live: true,
      }),
    ).toEqual({ ultracode: true });
  });

  test("a model change turns a live Ultracode off, matching the cleared parameter", () => {
    expect(
      ultracodeFlagSetting({
        effortChanged: true,
        fastModeChanged: false,
        modelChanged: true,
        live: true,
      }),
    ).toEqual({
      ultracode: false,
    });
  });

  test("nothing is sent when Ultracode is not live", () => {
    for (const live of [false, undefined]) {
      expect(
        ultracodeFlagSetting({
          effortChanged: true,
          fastModeChanged: false,
          modelChanged: true,
          live,
        }),
      ).toEqual({});
    }
    expect(
      ultracodeFlagSetting({
        effortChanged: false,
        fastModeChanged: false,
        modelChanged: false,
        live: true,
      }),
    ).toEqual({});
  });
});

describe("ultracodeRuntimeState", () => {
  test("reads the runtime-resolved block of a get_settings answer", () => {
    expect(
      ultracodeRuntimeState({
        effective: { ultracode: true },
        applied: {
          model: "claude-opus-5-5",
          effort: "high",
          ultracode: false,
          ultracodeRequested: true,
          ultracodeAvailable: false,
        },
      }),
    ).toEqual({ requested: true, active: false, available: false });
  });

  test("is undefined for a CLI that predates the fields", () => {
    expect(ultracodeRuntimeState({ applied: { model: "m", effort: null } })).toBeUndefined();
    expect(ultracodeRuntimeState({ effective: {} })).toBeUndefined();
    expect(ultracodeRuntimeState(null)).toBeUndefined();
    expect(ultracodeRuntimeState("applied")).toBeUndefined();
  });

  test("only a requested, inactive Ultracode produces a notice", () => {
    expect(ultracodeUnavailableNotice({ requested: true, active: true })).toBeUndefined();
    expect(ultracodeUnavailableNotice({ requested: false, active: false })).toBeUndefined();
    expect(ultracodeUnavailableNotice(undefined)).toBeUndefined();
    expect(
      ultracodeUnavailableNotice({ requested: true, active: false, available: false })?.detail,
    ).toContain("dynamic workflows are off");
  });
});

describe("Ultracode on the turn query", () => {
  test("starts the query with the flag-layer setting, alongside fast mode", async () => {
    const session = createSession();
    track(session.id);
    const prompt = sendPrompt(session.id, "Orchestrate this", {
      fastMode: true,
      parameterValues: { ultracode: true },
    });
    const call = await nextQueryCall();
    expect(call.options.settings).toEqual({ fastMode: true, ultracode: true });
    expect(getSession(session.id)?.ultracode).toBe(true);
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });

  test("leaves the setting out when it is off", async () => {
    const session = createSession();
    track(session.id);
    const prompt = sendPrompt(session.id, "Plain turn", { parameterValues: { ultracode: false } });
    const call = await nextQueryCall();
    expect(call.options.settings).toBeUndefined();
    expect(getSession(session.id)?.ultracode).toBe(false);
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });

  test("records a warning when the CLI declines a requested Ultracode", async () => {
    const getSettings = mock(async () => ({
      applied: { ultracode: false, ultracodeRequested: true, ultracodeAvailable: false },
    }));
    queryControlOverrides.getSettings = getSettings;
    const session = createSession();
    track(session.id);
    const prompt = sendPrompt(session.id, "Orchestrate this", {
      parameterValues: { ultracode: true },
    });
    const call = await nextQueryCall();
    await waitFor(() => (getSession(session.id)?.health?.listNotices().length ?? 0) > 0);
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(getSession(session.id)?.ultracodeApplied).toBe(false);
    expect(getSession(session.id)?.health?.listNotices()[0]).toMatchObject({
      message: "Ultracode is not available for this Claude session",
      method: "settings/ultracode",
      severity: "warning",
      source: "provider",
    });
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });

  test("does not read settings for a turn that did not ask for Ultracode", async () => {
    const getSettings = mock(async () => ({}));
    queryControlOverrides.getSettings = getSettings;
    const session = createSession();
    track(session.id);
    const prompt = sendPrompt(session.id, "Plain turn");
    const call = await nextQueryCall();
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
    expect(getSettings).not.toHaveBeenCalled();
  });
});

describe("Ultracode across live settings changes", () => {
  test("an effort change resends a live Ultracode so the CLI keeps it on", async () => {
    const applyFlagSettings = mock(async (_settings: Record<string, unknown>) => undefined);
    queryControlOverrides.applyFlagSettings = applyFlagSettings;
    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));
    session.ultracode = true;
    session.ultracodeApplied = true;

    await configureClaudeSession(session, { effort: "medium" });

    expect(applyFlagSettings).toHaveBeenCalledWith({ ultracode: true, effortLevel: "medium" });
    expect(session.ultracode).toBe(true);
    await finish();
  });

  test("an unavailable query does not resend Ultracode with a later effort change", async () => {
    queryControlOverrides.getSettings = mock(async () => ({
      applied: { ultracode: false, ultracodeRequested: true, ultracodeAvailable: false },
    }));
    const applyFlagSettings = mock(async (settings: Record<string, unknown>) => {
      if (settings.ultracode === true) throw new Error("ultracode is not available");
    });
    queryControlOverrides.applyFlagSettings = applyFlagSettings;
    const session = createSession();
    track(session.id);
    const prompt = sendPrompt(session.id, "Orchestrate this", {
      parameterValues: { ultracode: true },
    });
    const call = await nextQueryCall();
    await waitFor(() => session.ultracodeApplied === false);

    await configureClaudeSession(session, { effort: "medium" });
    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "medium" });
    expect(session.ultracode).toBe(true);
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });

  test("fast-mode changes preserve an applied Ultracode", async () => {
    const applyFlagSettings = mock(async (_settings: Record<string, unknown>) => undefined);
    queryControlOverrides.applyFlagSettings = applyFlagSettings;
    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));
    session.ultracode = true;
    session.ultracodeApplied = true;
    await configureClaudeSession(session, { fastMode: true });
    expect(applyFlagSettings).toHaveBeenCalledWith({ ultracode: true, fastMode: true });
    await finish();
  });

  test("an explicit toggle is applied and becomes the live value", async () => {
    const applyFlagSettings = mock(async (_settings: Record<string, unknown>) => undefined);
    queryControlOverrides.applyFlagSettings = applyFlagSettings;
    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));

    await configureClaudeSession(session, { parameterValues: { ultracode: true } });
    expect(applyFlagSettings).toHaveBeenLastCalledWith({ ultracode: true });
    expect(session.ultracode).toBe(true);
    expect(session.ultracodeApplied).toBe(true);

    await configureClaudeSession(session, { effort: "low", parameterValues: { ultracode: false } });
    expect(applyFlagSettings).toHaveBeenLastCalledWith({ ultracode: false, effortLevel: "low" });
    expect(session.ultracode).toBe(false);
    expect(session.ultracodeApplied).toBe(false);
    await finish();
  });

  test("a refused toggle keeps its error and leaves the live value alone", async () => {
    queryControlOverrides.applyFlagSettings = mock(async () => {
      throw new Error("apply_flag_settings: ultracode is not available for this session");
    });
    const { session, finish } = await inspectDuringTurn([], (s) => Boolean(s.queryControl));
    session.ultracode = false;
    session.ultracodeApplied = false;

    await expect(
      configureClaudeSession(session, { parameterValues: { ultracode: true } }),
    ).rejects.toThrow("ultracode is not available");
    expect(session.ultracode).toBe(false);
    await finish();
  });
});
