import { describe, expect, test } from "bun:test";
import { AGENT_INTERACTION_HOLD_CEILING_MS } from "@orkestrator/protocol/agent-interactions";

import {
  GROK_QUESTION_DEFAULT_TIMEOUT_MS,
  grokQuestionTimeoutAtLaunch,
  grokQuestionTimeoutFromEnv,
  questionTimeoutTomlLayer,
} from "./acp-question-timeout.js";

const FILES = { userConfig: "/grok-home/config.toml", requirements: "/etc/grok/requirements.toml" };
const RAISED = {
  timeoutMs: AGENT_INTERACTION_HOLD_CEILING_MS,
  env: { GROK_ASK_USER_QUESTION_TIMEOUT_SECS: String(AGENT_INTERACTION_HOLD_CEILING_MS / 1_000) },
  source: "raised",
};

function reader(files: Record<string, string>) {
  return (path: string) => files[path];
}

describe("Grok's ask_user_question timeout at launch", () => {
  test("raises Grok's default to the hold ceiling when nothing sets it", () => {
    expect(grokQuestionTimeoutAtLaunch({}, FILES, reader({}))).toEqual(RAISED);
    // A config.toml that says nothing about the question tool changes nothing.
    expect(
      grokQuestionTimeoutAtLaunch(
        {},
        FILES,
        reader({
          [FILES.userConfig]: '[toolset.bash]\ntimeout_secs = 60\n[models]\ndefault = "x"\n',
        }),
      ),
    ).toEqual(RAISED);
    // Turning the timeout on without a duration still leaves the duration to the bridge.
    expect(
      grokQuestionTimeoutAtLaunch(
        { GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED: "true" },
        FILES,
        reader({}),
      ),
    ).toEqual(RAISED);
  });

  test("honours and publishes a duration the user configured", () => {
    const userConfig = "[toolset.ask_user_question]\ntimeout_secs = 300 # five minutes\n";
    expect(
      grokQuestionTimeoutAtLaunch({}, FILES, reader({ [FILES.userConfig]: userConfig })),
    ).toEqual({ timeoutMs: 300_000, env: {}, source: "user-config" });
    // The environment outranks the user's config.toml, as in Grok.
    expect(
      grokQuestionTimeoutAtLaunch(
        { GROK_ASK_USER_QUESTION_TIMEOUT_SECS: "90" },
        FILES,
        reader({ [FILES.userConfig]: userConfig }),
      ),
    ).toEqual({ timeoutMs: 90_000, env: {}, source: "environment" });
    // Organisation requirements outrank the environment.
    expect(
      grokQuestionTimeoutAtLaunch(
        { GROK_ASK_USER_QUESTION_TIMEOUT_SECS: "90" },
        FILES,
        reader({ [FILES.requirements]: "[toolset.ask_user_question]\ntimeout_secs = 120\n" }),
      ),
    ).toEqual({ timeoutMs: 120_000, env: {}, source: "requirements" });
  });

  test("an off switch in any layer leaves the timeout off and the environment alone", () => {
    for (const [env, files] of [
      [{ GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED: "false" }, {}],
      [{}, { [FILES.userConfig]: "[toolset.ask_user_question]\ntimeout_enabled = false\n" }],
      [
        { GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED: "true" },
        { [FILES.requirements]: "[toolset.ask_user_question]\ntimeout_enabled = false\n" },
      ],
    ] as const) {
      expect(grokQuestionTimeoutAtLaunch(env, FILES, reader(files))).toEqual({
        timeoutMs: undefined,
        env: {},
        source: "off",
      });
    }
    // A higher layer turning it back on wins over a lower off switch.
    expect(
      grokQuestionTimeoutAtLaunch(
        {
          GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED: "true",
          GROK_ASK_USER_QUESTION_TIMEOUT_SECS: "60",
        },
        FILES,
        reader({ [FILES.userConfig]: "[toolset.ask_user_question]\ntimeout_enabled = false\n" }),
      ),
    ).toEqual({ timeoutMs: 60_000, env: {}, source: "environment" });
  });

  test("ignores values Grok ignores", () => {
    for (const secs of ["0", "-5", "1.5", "soon", ""]) {
      expect(
        grokQuestionTimeoutAtLaunch(
          { GROK_ASK_USER_QUESTION_TIMEOUT_SECS: secs },
          FILES,
          reader({}),
        ),
      ).toEqual(RAISED);
    }
    for (const toml of [
      "[toolset.ask_user_question]\ntimeout_secs = 0\n",
      "[toolset.ask_user_question]\ntimeout_secs = 1.5\n",
      '[toolset.ask_user_question]\ntimeout_secs = "300"\n',
      "this is [not toml",
    ]) {
      expect(questionTimeoutTomlLayer(toml)).toEqual({});
    }
    expect(questionTimeoutTomlLayer(undefined)).toEqual({});
    // Dotted keys are the same table.
    expect(questionTimeoutTomlLayer("[toolset]\nask_user_question.timeout_secs = 45\n")).toEqual({
      secs: 45,
    });
  });

  test("reads the environment alone for a child it did not launch", () => {
    expect(grokQuestionTimeoutFromEnv({})).toBe(GROK_QUESTION_DEFAULT_TIMEOUT_MS);
    expect(grokQuestionTimeoutFromEnv({ GROK_ASK_USER_QUESTION_TIMEOUT_SECS: "90" })).toBe(90_000);
    expect(grokQuestionTimeoutFromEnv({ GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED: "0" })).toBe(
      undefined,
    );
  });
});
