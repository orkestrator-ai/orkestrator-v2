import { describe, expect, test } from "bun:test";
import { parseCapabilitySessionEvidence } from "@orkestrator/protocol/capability-evidence";

import {
  capabilityEvidenceBody,
  invokedSkill,
  noteCapabilityInit,
  noteCapabilityUse,
  type CapabilityEvidenceState,
} from "./capability-evidence.js";

describe("capability evidence", () => {
  test("an unknown session is missing in band; a session before its first load has none", () => {
    expect(capabilityEvidenceBody(undefined)).toEqual({ state: "missing" });
    expect(capabilityEvidenceBody({})).toEqual({ state: "none" });
  });

  test("each init is a new generation with the loaded plugins and skills; use survives it", () => {
    const session: { capabilityEvidence?: CapabilityEvidenceState } = {};
    noteCapabilityInit(
      session,
      {
        claude_code_version: "2.1.326",
        plugins: [
          {
            name: "orkestrator-session",
            path: "/data/capability-session-plugins/abc123abc123abcd",
          },
          { name: "" },
          "junk",
        ],
        skills: ["orkestrator-session:review", 7, "local-skill"],
      },
      () => "2026-11-19T10:00:00.000Z",
    );
    noteCapabilityUse(session, "orkestrator-session:review");
    noteCapabilityUse(session, "local-skill");
    noteCapabilityUse(session, "orkestrator-session:review");
    noteCapabilityInit(session, { plugins: [], skills: [] }, () => "2026-11-19T10:05:00.000Z");
    const body = capabilityEvidenceBody(session);
    expect(body).toEqual({
      state: "evidence",
      generation: 2,
      loadedAt: "2026-11-19T10:05:00.000Z",
      plugins: [],
      skills: [],
      usedSkills: ["local-skill", "orkestrator-session:review"],
    });
    // The backend reads exactly what the bridge writes.
    expect(parseCapabilitySessionEvidence(body)).toEqual(body);
  });

  test("the first generation keeps plugin directories and the provider version", () => {
    const session: { capabilityEvidence?: CapabilityEvidenceState } = {};
    noteCapabilityInit(session, {
      claude_code_version: "2.1.326",
      plugins: [{ name: "orkestrator-session", path: "/root/0123456789abcdef" }],
      skills: ["orkestrator-session:review"],
    });
    expect(capabilityEvidenceBody(session)).toMatchObject({
      generation: 1,
      providerVersion: "2.1.326",
      plugins: [{ name: "orkestrator-session", path: "/root/0123456789abcdef" }],
      skills: ["orkestrator-session:review"],
    });
  });

  test("only the Skill tool names a skill, and never with its arguments", () => {
    expect(invokedSkill("Skill", { skill: "review", args: "secret" })).toBe("review");
    expect(invokedSkill("Skill", { command: "/review" })).toBe("review");
    expect(invokedSkill("Bash", { skill: "review" })).toBeUndefined();
    expect(invokedSkill("Skill", { skill: "x".repeat(300) })).toBeUndefined();
    expect(invokedSkill("Skill", null)).toBeUndefined();
  });

  test("use is ignored before a load and bounded after one", () => {
    const session: { capabilityEvidence?: CapabilityEvidenceState } = {};
    noteCapabilityUse(session, "early");
    expect(session.capabilityEvidence).toBeUndefined();
    noteCapabilityInit(session, {});
    for (let index = 0; index < 300; index += 1) noteCapabilityUse(session, `skill-${index}`);
    const used = session.capabilityEvidence!.usedSkills;
    expect(used).toHaveLength(256);
    expect(used.at(-1)).toBe("skill-299");
  });

  test("a malformed body reads as no evidence", () => {
    expect(parseCapabilitySessionEvidence({ state: "evidence", generation: 0 })).toEqual({
      state: "none",
    });
    expect(parseCapabilitySessionEvidence("nope")).toEqual({ state: "none" });
    expect(parseCapabilitySessionEvidence({ state: "missing" })).toEqual({ state: "missing" });
  });
});
