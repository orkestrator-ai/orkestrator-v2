import { describe, expect, test } from "bun:test";
import { COORDINATOR_MAIL_ORIGIN_NOTE } from "./agent-mail.js";
import { coordinatorCallTurnOrigin } from "./coordinator.js";
import {
  COORDINATOR_DELEGATION_FRAME_CLOSE,
  COORDINATOR_DELEGATION_FRAME_OPEN,
  COORDINATOR_DELEGATION_PRESENTATION,
  COORDINATOR_JOB_DELEGATION_INSTRUCTION,
  coordinatorDelegationFromMail,
  coordinatorDelegationInstruction,
  createCoordinatorDelegatedPrompt,
  createCoordinatorMailOriginPrompt,
  isTrustedUserPromptPresentation,
  parseCoordinatorDelegatedPrompt,
} from "./review-evidence-frames.js";

/**
 * To-do 6080 task 5: a delegated prompt says when the coordinator's turn
 * arose from agent mail, as the coordinator's mail already does.
 */

const frameInput = {
  projectId: "project-1",
  coordinatorId: "coordinator-1",
  conversationId: "conversation-1",
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  instruction: COORDINATOR_JOB_DELEGATION_INSTRUCTION,
};

/**
 * The parser as it stood before the origin note, kept verbatim: an older
 * backend or renderer reads stored frames with exactly this.
 */
function parseBeforeOriginNote(source: string): { frame: string; source: string } | null {
  const frameStart = `${COORDINATOR_DELEGATION_FRAME_OPEN}\n`;
  if (!source.startsWith(frameStart)) return null;
  const framedClose = `\n${COORDINATOR_DELEGATION_FRAME_CLOSE}`;
  const close = source.indexOf(framedClose, frameStart.length);
  if (close < 0) return null;
  const afterClose = close + framedClose.length;
  if (!source.startsWith("\n\n", afterClose)) return null;
  return { frame: source.slice(0, afterClose), source: source.slice(afterClose + 2) };
}

describe("coordinatorCallTurnOrigin", () => {
  test("only a turn the user started is unmarked", () => {
    expect(coordinatorCallTurnOrigin("user")).toBeUndefined();
    expect(coordinatorCallTurnOrigin("mail")).toBe("mail");
    expect(coordinatorCallTurnOrigin(undefined)).toBe("mail");
    expect(coordinatorCallTurnOrigin("something-else")).toBe("mail");
  });

  test("a recorded origin (a scheduled fire's) wins over the newest turn, both ways", () => {
    expect(coordinatorCallTurnOrigin("user", "mail")).toBe("mail");
    expect(coordinatorCallTurnOrigin("mail", "user")).toBeUndefined();
    expect(coordinatorCallTurnOrigin(undefined, "user")).toBeUndefined();
  });

  test("an unrecognised recorded origin falls back to the newest turn", () => {
    expect(coordinatorCallTurnOrigin("user", "bogus")).toBeUndefined();
    expect(coordinatorCallTurnOrigin("mail", null)).toBe("mail");
  });
});

describe("the delegation frame's origin note", () => {
  test("a frame from the user's turn is byte-for-byte what it was", () => {
    const { frame, source } = createCoordinatorDelegatedPrompt(frameInput, "Build it");
    expect(frame).toBe(
      [
        COORDINATOR_DELEGATION_FRAME_OPEN,
        "Project: project-1",
        "Coordinator: coordinator-1",
        "Conversation: conversation-1",
        "Base branch: main",
        `Base commit: ${"a".repeat(40)}`,
        COORDINATOR_JOB_DELEGATION_INSTRUCTION,
        COORDINATOR_DELEGATION_FRAME_CLOSE,
      ].join("\n"),
    );
    expect(source).toBe(`${frame}\n\nBuild it`);
    expect(coordinatorDelegationFromMail(frame)).toBe(false);
  });

  test("a frame from a mail turn ends with the note its mail carries", () => {
    const { frame, source } = createCoordinatorDelegatedPrompt(
      { ...frameInput, turnOrigin: "mail" },
      "Build it",
    );
    const lines = frame.split("\n");
    expect(lines.at(-2)).toBe(COORDINATOR_MAIL_ORIGIN_NOTE);
    expect(lines.at(-3)).toBe(COORDINATOR_JOB_DELEGATION_INSTRUCTION);
    expect(coordinatorDelegationFromMail(frame)).toBe(true);
    expect(parseCoordinatorDelegatedPrompt(source)).toEqual({ frame, source: "Build it" });
  });

  test("an instruction carrying the note builds the same frame (a fork on an older node)", () => {
    const withField = createCoordinatorDelegatedPrompt(
      { ...frameInput, turnOrigin: "mail" },
      "Build it",
    );
    const inInstruction = createCoordinatorDelegatedPrompt(
      {
        ...frameInput,
        instruction: coordinatorDelegationInstruction(frameInput.instruction, "mail"),
      },
      "Build it",
    );
    expect(inInstruction).toEqual(withField);
    expect(coordinatorDelegationInstruction("Report back.", undefined)).toBe("Report back.");
  });

  test("an older reader parses the marked frame and keeps the prompt intact", () => {
    const prompt = "Line one\n\n<orkestrator-coordinator-delegation>\nnot a frame";
    for (const turnOrigin of [undefined, "mail"] as const) {
      const delegated = createCoordinatorDelegatedPrompt({ ...frameInput, turnOrigin }, prompt);
      expect(parseBeforeOriginNote(delegated.source)).toEqual({
        frame: delegated.frame,
        source: prompt,
      });
      // The stored presentation an older backend validates.
      expect(
        isTrustedUserPromptPresentation({
          kind: COORDINATOR_DELEGATION_PRESENTATION,
          frame: delegated.frame,
        }),
      ).toBe(true);
    }
  });

  test("a later prompt from a mail turn carries the note only", () => {
    const { frame, source } = createCoordinatorMailOriginPrompt("Continue with step two.");
    expect(frame).toBe(
      [
        COORDINATOR_DELEGATION_FRAME_OPEN,
        COORDINATOR_MAIL_ORIGIN_NOTE,
        COORDINATOR_DELEGATION_FRAME_CLOSE,
      ].join("\n"),
    );
    expect(source).toBe(`${frame}\n\nContinue with step two.`);
    expect(coordinatorDelegationFromMail(frame)).toBe(true);
    expect(parseCoordinatorDelegatedPrompt(source)).toEqual({
      frame,
      source: "Continue with step two.",
    });
    expect(parseBeforeOriginNote(source)?.source).toBe("Continue with step two.");
  });

  test("the note in the prompt body does not mark the frame", () => {
    const { frame } = createCoordinatorDelegatedPrompt(frameInput, COORDINATOR_MAIL_ORIGIN_NOTE);
    expect(coordinatorDelegationFromMail(frame)).toBe(false);
  });
});
