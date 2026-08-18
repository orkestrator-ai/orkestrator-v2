#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const responseFile = process.env.CLAUDE_SDK_CONTRACT_RESPONSE_FILE;
if (!responseFile) process.exit(2);

let questionSent = false;
// The test parses the response file as one JSON document. Recording a second
// response would concatenate two, so a duplicate would surface as an opaque
// syntax error exactly when the SDK contract this pins has changed.
let responseRecorded = false;
let sessionId = "contract-session";
const lines = createInterface({ input: process.stdin });

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  if (message.type === "control_request") {
    const request = message.request as Record<string, unknown>;
    if (request?.subtype === "initialize") {
      write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: {
            commands: [],
            output_style: "default",
            available_output_styles: [],
            models: [],
            account: {},
          },
        },
      });
    }
    return;
  }

  if (message.type === "user" && !questionSent) {
    questionSent = true;
    if (typeof message.session_id === "string") sessionId = message.session_id;
    write({
      type: "control_request",
      request_id: "contract-question-request",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: "contract-question-tool",
        input: {
          questions: [
            {
              question: "Choose a deterministic answer",
              header: "Contract",
              options: [{ label: "Continue", description: "Continue the probe" }],
              multiSelect: false,
            },
          ],
        },
        permission_suggestions: [],
      },
    });
    return;
  }

  if (message.type === "control_response") {
    const response = message.response as Record<string, unknown>;
    if (response?.request_id !== "contract-question-request") return;
    if (responseRecorded) return;
    responseRecorded = true;
    writeFileSync(
      responseFile,
      JSON.stringify({
        argv: process.argv.slice(2),
        response,
      }),
    );
    write({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 0,
      is_error: false,
      num_turns: 1,
      result: "contract complete",
      session_id: sessionId,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "00000000-0000-4000-8000-000000000001",
    });
    lines.close();
  }
});
