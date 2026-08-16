#!/usr/bin/env bun

import { lines, type JsonObject } from "./fake-agent-context.js";
import { handleFinalMessage } from "./fake-agent-final.js";
import { handlePromptSetup } from "./fake-agent-prompt-setup.js";
import { handlePromptStart } from "./fake-agent-prompt-start.js";
import { handleSessionMessage } from "./fake-agent-session.js";

lines.on("line", (line) => {
  const message = JSON.parse(line) as JsonObject;
  if (handleSessionMessage(message)) return;
  if (handlePromptSetup(message)) return;
  if (handlePromptStart(message)) return;
  handleFinalMessage(message);
});
