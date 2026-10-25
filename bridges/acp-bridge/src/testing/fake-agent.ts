#!/usr/bin/env bun

import { appendFileSync } from "node:fs";

import { handlePolicyDenial } from "./fake-agent-policy-denial.js";
import { lines, type JsonObject } from "./fake-agent-context.js";
import { handleFinalMessage } from "./fake-agent-final.js";
import { handlePromptSetup } from "./fake-agent-prompt-setup.js";
import { handlePromptStart } from "./fake-agent-prompt-start.js";
import { handleSessionMessage } from "./fake-agent-session.js";

// Capture only the launch contract under test, never the child's full environment.
if (process.env.FAKE_ACP_SPAWN_FILE) {
  appendFileSync(
    process.env.FAKE_ACP_SPAWN_FILE,
    JSON.stringify({
      args: process.argv.slice(2),
      folderTrust: process.env.GROK_FOLDER_TRUST,
      questionTimeoutSecs: process.env.GROK_ASK_USER_QUESTION_TIMEOUT_SECS,
    }) + "\n",
  );
}

lines.on("line", (line) => {
  const message = JSON.parse(line) as JsonObject;
  if (handleSessionMessage(message)) return;
  if (handlePromptSetup(message)) return;
  if (handlePolicyDenial(message)) return;
  if (handlePromptStart(message)) return;
  handleFinalMessage(message);
});
