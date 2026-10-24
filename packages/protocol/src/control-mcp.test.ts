import { describe, expect, test } from "bun:test";
import {
  CONTROL_MCP_GRANTABLE_CAPABILITIES,
  CONTROL_MCP_PROFILE_CAPABILITIES,
  controlMcpActionAllowed,
  controlMcpConfirmationRule,
  isApprovalResolution,
  resolveControlMcpCapabilities,
  type ControlMcpCredentialPolicy,
} from "./control-mcp.js";
import { PUBLIC_ACTION_NAMES, PUBLIC_ACTIONS } from "./public-api.js";
import { PUBLIC_ACTION_INPUTS } from "./public-api-inputs.js";

function credential(
  profile: ControlMcpCredentialPolicy["profile"],
  capabilities = resolveControlMcpCapabilities(profile === "custom" ? "full" : profile),
  deniedActions: ControlMcpCredentialPolicy["deniedActions"] = [],
): ControlMcpCredentialPolicy {
  return { id: "test", profile, capabilities, deniedActions };
}

describe("Control MCP credential policy", () => {
  test("no profile can be granted host", () => {
    expect(CONTROL_MCP_GRANTABLE_CAPABILITIES).not.toContain("host");
    for (const profile of ["voice", "full", "read-only"] as const) {
      for (const action of PUBLIC_ACTION_NAMES) {
        if (PUBLIC_ACTION_INPUTS[action].capability !== "host") continue;
        expect(controlMcpActionAllowed(credential(profile), action)).toBe(false);
      }
    }
    expect(() => resolveControlMcpCapabilities("custom", ["host"])).toThrow();
  });

  test("the voice preset leaves out projects, settings, destructive and exec", () => {
    expect(CONTROL_MCP_PROFILE_CAPABILITIES.voice).toEqual([
      "discovery",
      "sessions.read",
      "sessions.control",
      "interactions",
      "environments.lifecycle",
      "tickets",
      "mail",
    ]);
    const voice = credential("voice");
    expect(controlMcpActionAllowed(voice, "session.prompt")).toBe(true);
    expect(controlMcpActionAllowed(voice, "environment.delete")).toBe(false);
    expect(controlMcpActionAllowed(voice, "environment.exec")).toBe(false);
    expect(controlMcpActionAllowed(voice, "project.create")).toBe(false);
    expect(controlMcpActionAllowed(voice, "project.config.set")).toBe(false);
    // Exec can be granted explicitly; it then confirms on every voice call.
    const withExec = credential("voice", resolveControlMcpCapabilities("voice", ["exec"]));
    expect(controlMcpActionAllowed(withExec, "environment.exec")).toBe(true);
    expect(controlMcpConfirmationRule("environment.exec", "voice")).toBe("always");
  });

  test("read-only refuses every mutation and denied actions win", () => {
    const readOnly = credential("read-only");
    for (const action of PUBLIC_ACTION_NAMES) {
      if (PUBLIC_ACTIONS[action].mutation) {
        expect(controlMcpActionAllowed(readOnly, action)).toBe(false);
      }
    }
    expect(controlMcpActionAllowed(readOnly, "session.transcript")).toBe(true);
    const denied = credential("full", undefined, ["session.transcript"]);
    expect(controlMcpActionAllowed(denied, "session.transcript")).toBe(false);
  });

  test("capability lists are normalized and validated", () => {
    expect(resolveControlMcpCapabilities("custom", ["mail", "discovery", "mail"])).toEqual([
      "discovery",
      "mail",
    ]);
    expect(() => resolveControlMcpCapabilities("custom")).toThrow();
    expect(() => resolveControlMcpCapabilities("custom", [])).toThrow();
    expect(() => resolveControlMcpCapabilities("voice", ["typo"])).toThrow("typo");
  });

  test("confirmation rules follow the risk table per profile", () => {
    expect(controlMcpConfirmationRule("environment.delete", "full")).toBe("always");
    expect(controlMcpConfirmationRule("environment.recreate", "full")).toBe("discard");
    expect(controlMcpConfirmationRule("environment.stop", "full")).toBe("none");
    expect(controlMcpConfirmationRule("environment.stop", "voice")).toBe("always");
    expect(controlMcpConfirmationRule("session.interaction.resolve", "voice")).toBe("approval");
    expect(controlMcpConfirmationRule("session.interaction.resolve", "full")).toBe("none");
    expect(controlMcpConfirmationRule("session.prompt", "voice")).toBe("none");
    expect(isApprovalResolution("command-approval", "answer")).toBe(true);
    expect(isApprovalResolution("file-approval", "approve-for-session")).toBe(true);
    expect(isApprovalResolution("command-approval", "deny")).toBe(false);
    expect(isApprovalResolution("question", "answer")).toBe(false);
  });
});
