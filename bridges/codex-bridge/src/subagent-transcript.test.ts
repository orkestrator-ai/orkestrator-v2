import { describe, expect, test } from "bun:test";
import {
  deriveSubagentPartsFromTranscriptRecords,
  mergeSubagentPartsIntoMessageParts,
  parseSubAgentActivityRecords,
  parseTranscriptRecords,
  type TranscriptRecord,
} from "./subagent-transcript.js";

function recordsFromLines(lines: string[]): TranscriptRecord[] {
  return parseTranscriptRecords(lines);
}

function validFernetEnvelope(): string {
  return Buffer.concat([
    Buffer.from([0x80]),
    Buffer.alloc(8),
    Buffer.alloc(16),
    Buffer.alloc(16),
    Buffer.alloc(32),
  ]).toString("base64url");
}

function deriveSingleSubagent(
  childRecords: TranscriptRecord[],
  spawnArgs: Record<string, unknown> = {},
) {
  return deriveSubagentPartsFromTranscriptRecords([
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "spawn",
        arguments: JSON.stringify(spawnArgs),
      },
    },
  ], new Map([["agent", childRecords]]), new Map([["spawn", "agent"]]))[0];
}

describe("parseTranscriptRecords", () => {
  test("skips invalid lines and non-object payloads", () => {
    const records = parseTranscriptRecords([
      "not-json",
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: "invalid",
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:17:24.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
        },
      }),
    ]);

    expect(records).toEqual([
      {
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: undefined,
      },
      {
        timestamp: "2026-04-16T11:17:24.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
        },
      },
    ]);
  });

  test("normalizes non-string metadata while retaining object-like array payloads", () => {
    const records = parseTranscriptRecords([
      JSON.stringify({ timestamp: 123, type: false, payload: [] }),
      JSON.stringify({ timestamp: null, type: {}, payload: null }),
      JSON.stringify(["array record"]),
    ]);

    expect(records).toEqual([
      { timestamp: undefined, type: undefined, payload: [] },
      { timestamp: undefined, type: undefined, payload: undefined },
      { timestamp: undefined, type: undefined, payload: undefined },
    ]);
  });
});

describe("parseSubAgentActivityRecords", () => {
  test("ignores malformed activities and keeps the first valid mapping", () => {
    const activity = (payload: Record<string, unknown>): TranscriptRecord => ({
      type: "event_msg",
      payload: { type: "sub_agent_activity", ...payload },
    });
    const records: TranscriptRecord[] = [
      { type: "response_item", payload: { type: "sub_agent_activity", event_id: "wrong-type", agent_thread_id: "child" } },
      activity({ event_id: "", agent_thread_id: "child" }),
      activity({ event_id: 12, agent_thread_id: "child" }),
      activity({ event_id: "call", agent_thread_id: null }),
      activity({ event_id: "call", agent_thread_id: "child-1", agent_path: 42 }),
      activity({ event_id: "call", agent_thread_id: "child-2", agent_path: "/root/later" }),
    ];

    expect(parseSubAgentActivityRecords(records)).toEqual([
      { callId: "call", agentThreadId: "child-1", agentPath: undefined },
      { callId: "call", agentThreadId: "child-2", agentPath: "/root/later" },
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords([
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call",
          arguments: JSON.stringify({ message: "Keep the first mapping" }),
        },
      },
      ...records,
    ], new Map());
    expect(parts[0]?.subagentId).toBe("child-1");
  });
});

describe("deriveSubagentPartsFromTranscriptRecords", () => {
  test("creates a folded subagent part and hydrates child actions", () => {
    const parentRecords = recordsFromLines([
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "explorer",
            message: "Inspect the Codex integration",
          }),
          call_id: "call-spawn-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-spawn-1",
          output: JSON.stringify({
            agent_id: "agent-1",
            nickname: "Lovelace",
          }),
        },
      }),
    ]);

    const childRecordsByAgentId = new Map<string, TranscriptRecord[]>([
      [
        "agent-1",
        recordsFromLines([
          JSON.stringify({
            timestamp: "2026-04-16T11:17:23.681Z",
            type: "session_meta",
            payload: {
              id: "agent-1",
              agent_nickname: "Lovelace",
              agent_role: "explorer",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-16T11:17:31.150Z",
            type: "event_msg",
            payload: {
              type: "agent_message",
              phase: "commentary",
              message: "I am checking the codebase now.",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-16T11:17:31.153Z",
            type: "response_item",
            payload: {
              type: "function_call",
              name: "exec_command",
              arguments: JSON.stringify({
                cmd: "rg -n \"codex\" src",
                workdir: "/workspace",
              }),
              call_id: "child-call-1",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-16T11:17:31.237Z",
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "child-call-1",
              output: "Command output",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-16T11:19:00.119Z",
            type: "event_msg",
            payload: {
              type: "task_complete",
            },
          }),
        ]),
      ],
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(
      parentRecords,
      childRecordsByAgentId,
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      type: "subagent",
      content: "Lovelace",
      subagentId: "agent-1",
      subagentName: "Lovelace",
      subagentRole: "explorer",
      subagentPrompt: "Inspect the Codex integration",
      subagentActionCount: 1,
      toolState: "success",
      subagentActions: [
        {
          type: "text",
          content: "I am checking the codebase now.",
        },
        {
          type: "tool-invocation",
          content: "exec_command",
          toolName: "exec_command",
          toolArgs: {
            cmd: "rg -n \"codex\" src",
            workdir: "/workspace",
            command: "rg -n \"codex\" src",
          },
          toolState: undefined,
          toolTitle: "exec_command",
          toolOutput: "Command output",
          toolError: undefined,
        },
      ],
    });
  });

  test("keeps pending subagents visible before the child transcript exists", () => {
    const parentRecords = recordsFromLines([
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "worker",
            message: "Implement the patch",
          }),
          call_id: "call-spawn-2",
        },
      }),
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(parentRecords, new Map());

    expect(parts).toHaveLength(1);
    expect(parts[0]?.toolState).toBe("pending");
    expect(parts[0]?.subagentActionCount).toBe(0);
    expect(parts[0]?.subagentRole).toBe("worker");
    expect(parts[0]?.subagentPrompt).toBe("Implement the patch");
  });

  test("keeps top-level success when a child tool fails but the subagent completes", () => {
    const parentRecords = recordsFromLines([
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "worker",
            message: "Check the patch",
          }),
          call_id: "call-spawn-3",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-spawn-3",
          output: JSON.stringify({
            agent_id: "agent-3",
            nickname: "Turing",
          }),
        },
      }),
    ]);

    const childRecordsByAgentId = new Map<string, TranscriptRecord[]>([
      [
        "agent-3",
        recordsFromLines([
          JSON.stringify({
            timestamp: "2026-04-16T11:17:23.681Z",
            type: "session_meta",
            payload: {
              id: "agent-3",
              agent_nickname: "Turing",
              agent_role: "worker",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-16T11:17:31.153Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              name: "exec_command",
              input: JSON.stringify({
                cmd: "exit 1",
              }),
              output: "Command failed",
              status: "failed",
              call_id: "child-call-3",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-16T11:19:00.119Z",
            type: "event_msg",
            payload: {
              type: "task_complete",
            },
          }),
        ]),
      ],
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(
      parentRecords,
      childRecordsByAgentId,
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]?.toolState).toBe("success");
    expect(parts[0]?.subagentActions[0]).toEqual({
      type: "tool-invocation",
      content: "exec_command",
      toolName: "exec_command",
      toolArgs: {
        cmd: "exit 1",
        command: "exit 1",
      },
      toolState: "failure",
      toolTitle: "exec_command",
      toolOutput: undefined,
      toolError: "Command failed",
    });
  });

  test("uses wait_agent results to mark successful subagents before child completion records arrive", () => {
    const parentRecords = recordsFromLines([
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "explorer",
            message: "Inspect the bridge",
          }),
          call_id: "call-spawn-4",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-spawn-4",
          output: JSON.stringify({
            agent_id: "agent-4",
            nickname: "Hopper",
          }),
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:18:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "wait_agent",
          arguments: JSON.stringify({
            targets: ["agent-4"],
            timeout_ms: 300000,
          }),
          call_id: "call-wait-4",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:18:24.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-wait-4",
          output: JSON.stringify({
            status: {
              "agent-4": {
                completed: "Done",
              },
            },
            timed_out: false,
          }),
        },
      }),
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(parentRecords, new Map());

    expect(parts).toHaveLength(1);
    expect(parts[0]?.toolState).toBe("success");
    expect(parts[0]?.subagentActionCount).toBe(0);
  });

  test("marks subagents as failed on explicit task failure", () => {
    const parentRecords = recordsFromLines([
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "worker",
            message: "Apply the patch",
          }),
          call_id: "call-spawn-5",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-spawn-5",
          output: JSON.stringify({
            agent_id: "agent-5",
            nickname: "Shannon",
          }),
        },
      }),
    ]);

    const childRecordsByAgentId = new Map<string, TranscriptRecord[]>([
      [
        "agent-5",
        recordsFromLines([
          JSON.stringify({
            timestamp: "2026-04-16T11:17:23.681Z",
            type: "session_meta",
            payload: {
              id: "agent-5",
              agent_nickname: "Shannon",
              agent_role: "worker",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-16T11:19:00.119Z",
            type: "event_msg",
            payload: {
              type: "task_failed",
            },
          }),
        ]),
      ],
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(
      parentRecords,
      childRecordsByAgentId,
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]?.toolState).toBe("failure");
  });

  for (const eventType of ["task_error", "task_aborted", "task_cancelled"]) {
    test(`marks subagents as failed on ${eventType}`, () => {
      const parentRecords = recordsFromLines([
        JSON.stringify({
          timestamp: "2026-04-16T11:17:23.623Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "spawn_agent",
            arguments: JSON.stringify({
              agent_type: "worker",
              message: "Handle the failure",
            }),
            call_id: "call-spawn-extra-failure",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-16T11:17:23.681Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-spawn-extra-failure",
            output: JSON.stringify({
              agent_id: "agent-extra-failure",
              nickname: "Shannon",
            }),
          },
        }),
      ]);

      const childRecordsByAgentId = new Map<string, TranscriptRecord[]>([
        [
          "agent-extra-failure",
          recordsFromLines([
            JSON.stringify({
              timestamp: "2026-04-16T11:17:23.681Z",
              type: "session_meta",
              payload: {
                id: "agent-extra-failure",
                agent_nickname: "Shannon",
                agent_role: "worker",
              },
            }),
            JSON.stringify({
              timestamp: "2026-04-16T11:19:00.119Z",
              type: "event_msg",
              payload: {
                type: eventType,
              },
            }),
          ]),
        ],
      ]);

      const parts = deriveSubagentPartsFromTranscriptRecords(
        parentRecords,
        childRecordsByAgentId,
      );

      expect(parts).toHaveLength(1);
      expect(parts[0]?.toolState).toBe("failure");
    });
  }

  test("uses wait_agent failure results when child completion records are missing", () => {
    const parentRecords = recordsFromLines([
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "worker",
            message: "Inspect the bridge",
          }),
          call_id: "call-spawn-wait-failure",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-spawn-wait-failure",
          output: JSON.stringify({
            agent_id: "agent-wait-failure",
            nickname: "Hopper",
          }),
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:18:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "wait_agent",
          arguments: JSON.stringify({
            targets: ["agent-wait-failure"],
            timeout_ms: 300000,
          }),
          call_id: "call-wait-failure",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:18:24.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-wait-failure",
          output: JSON.stringify({
            status: {
              "agent-wait-failure": {
                failed: "Exited 1",
              },
            },
            timed_out: false,
          }),
        },
      }),
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(parentRecords, new Map());

    expect(parts).toHaveLength(1);
    expect(parts[0]?.toolState).toBe("failure");
  });

  test("uses wait_agent cancellation results when child completion records are missing", () => {
    const parentRecords = recordsFromLines([
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "worker",
            message: "Inspect the bridge",
          }),
          call_id: "call-spawn-wait-cancelled",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-spawn-wait-cancelled",
          output: JSON.stringify({
            agent_id: "agent-wait-cancelled",
            nickname: "Hopper",
          }),
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:18:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "wait_agent",
          arguments: JSON.stringify({
            targets: ["agent-wait-cancelled"],
            timeout_ms: 300000,
          }),
          call_id: "call-wait-cancelled",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:18:24.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-wait-cancelled",
          output: JSON.stringify({
            status: {
              "agent-wait-cancelled": {
                cancelled: true,
              },
            },
            timed_out: false,
          }),
        },
      }),
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(parentRecords, new Map());

    expect(parts).toHaveLength(1);
    expect(parts[0]?.toolState).toBe("failure");
  });

  test("uses the resolved spawn-call map and lets matching output IDs take precedence", () => {
    const parentRecords: TranscriptRecord[] = [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ message: "Resolved only" }),
          call_id: "call-resolved",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ message: "Output wins" }),
          call_id: "call-output",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-output",
          output: JSON.stringify({ agent_id: "output-agent", nickname: "Output" }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "unrelated-call",
          output: JSON.stringify({ agent_id: "wrong-agent" }),
        },
      },
    ];
    const childRecords = new Map<string, TranscriptRecord[]>([
      ["resolved-agent", [{ type: "event_msg", payload: { type: "task_complete" } }]],
      ["output-agent", [{ type: "event_msg", payload: { type: "task_complete" } }]],
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(
      parentRecords,
      childRecords,
      new Map([
        ["call-resolved", "resolved-agent"],
        ["call-output", "ignored-resolved-agent"],
        ["unrelated-call", "wrong-agent"],
      ]),
    );

    expect(parts.map((part) => ({
      prompt: part.subagentPrompt,
      id: part.subagentId,
      name: part.subagentName,
      state: part.toolState,
    }))).toEqual([
      { prompt: "Resolved only", id: "resolved-agent", name: undefined, state: "success" },
      { prompt: "Output wins", id: "output-agent", name: "Output", state: "success" },
    ]);
  });

  test("retains resolved IDs across malformed or blank matching outputs", () => {
    const parentRecords: TranscriptRecord[] = ["{broken", "", JSON.stringify({ agent_id: " " })]
      .flatMap((output, index) => {
        const callId = `call-${index}`;
        return [
          {
            type: "response_item",
            payload: {
              type: "function_call",
              name: "spawn_agent",
              arguments: "",
              call_id: callId,
            },
          },
          {
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: callId,
              output,
            },
          },
        ];
      });
    const resolved = new Map([
      ["call-0", "resolved-0"],
      ["call-1", "resolved-1"],
      ["call-2", "resolved-2"],
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(parentRecords, new Map(), resolved);

    expect(parts.map((part) => part.subagentId)).toEqual([
      "resolved-0",
      "resolved-1",
      "resolved-2",
    ]);
    expect(parts.every((part) => part.subagentRole === undefined)).toBe(true);
    expect(parts.every((part) => part.subagentPrompt === undefined)).toBe(true);
  });

  test("ignores malformed spawn records and non-matching outputs", () => {
    const parts = deriveSubagentPartsFromTranscriptRecords([
      { type: "event_msg", payload: { type: "function_call", name: "spawn_agent", call_id: "event" } },
      { type: "response_item", payload: { type: "function_call", name: "other", call_id: "other" } },
      { type: "response_item", payload: { type: "function_call", name: "spawn_agent" } },
      { type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: " " } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "missing", output: "{}" } },
      { type: "response_item", payload: { type: "function_call_output", output: "{}" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: " ", output: "{}" } },
      { type: "response_item" },
    ], new Map());

    expect(parts).toEqual([]);
  });

  test("hydrates duplicate child IDs into both spawn parts without losing prompts", () => {
    const parentRecords: TranscriptRecord[] = ["First", "Second"].flatMap((message, index) => {
      const callId = `call-${index}`;
      return [
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "spawn_agent",
            arguments: JSON.stringify({ message }),
            call_id: callId,
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({ agent_id: "shared-agent" }),
          },
        },
      ];
    });
    const childRecords = new Map<string, TranscriptRecord[]>([[
      "shared-agent",
      [{ type: "event_msg", payload: { type: "task_complete" } }],
    ]]);

    const parts = deriveSubagentPartsFromTranscriptRecords(parentRecords, childRecords);

    expect(parts.map((part) => [part.subagentPrompt, part.subagentId, part.toolState])).toEqual([
      ["First", "shared-agent", "success"],
      ["Second", "shared-agent", "success"],
    ]);
  });

  test("normalizes empty and non-JSON tool arguments", () => {
    const childRecords: TranscriptRecord[] = [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "empty_args",
          arguments: "",
          call_id: "empty",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "raw_args",
          arguments: "not json",
          call_id: "raw",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "array_args",
          arguments: "[]",
          call_id: "array",
        },
      },
    ];

    const [part] = deriveSubagentPartsFromTranscriptRecords([
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: "{}",
          call_id: "spawn",
        },
      },
    ], new Map([["agent", childRecords]]), new Map([["spawn", "agent"]]));

    expect(part?.subagentActions.map((action) => action.toolArgs)).toEqual([
      undefined,
      { input: "not json" },
      [],
    ]);
  });

  test("serializes primitive, object, and circular tool outputs", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const childRecords: TranscriptRecord[] = [];
    const outputs: Array<[string, unknown]> = [
      ["undefined", undefined],
      ["number", 42],
      ["boolean", false],
      ["null", null],
      ["object", { ok: true }],
      ["circular", circular],
    ];
    for (const [callId, output] of outputs) {
      childRecords.push(
        {
          type: "response_item",
          payload: { type: "function_call", name: callId, arguments: "{}", call_id: callId },
        },
        {
          type: "response_item",
          payload: { type: "function_call_output", call_id: callId, output },
        },
      );
    }

    const [part] = deriveSubagentPartsFromTranscriptRecords([
      {
        type: "response_item",
        payload: { type: "function_call", name: "spawn_agent", call_id: "spawn" },
      },
    ], new Map([["agent", childRecords]]), new Map([["spawn", "agent"]]));

    expect(part?.subagentActions.map((action) => action.toolOutput)).toEqual([
      undefined,
      "42",
      "false",
      "null",
      "{\n  \"ok\": true\n}",
      "[object Object]",
    ]);
    expect(part?.subagentActions.every((action) => action.toolState === undefined)).toBe(true);
  });

  test("applies custom tool outputs while preserving their terminal states", () => {
    const childRecords: TranscriptRecord[] = [
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "completed_tool",
          input: { key: "value" },
          output: { done: true },
          status: "completed",
          call_id: "completed",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "pending_tool",
          input: "raw input",
          call_id: "pending",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "failed_without_output",
          status: "failed",
          call_id: "failed",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "pending",
          output: "later output",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "unknown",
          output: "ignored",
        },
      },
      {
        type: "response_item",
        payload: { type: "custom_tool_call_output", output: "ignored" },
      },
    ];
    const [part] = deriveSubagentPartsFromTranscriptRecords([
      {
        type: "response_item",
        payload: { type: "function_call", name: "spawn_agent", call_id: "spawn" },
      },
    ], new Map([["agent", childRecords]]), new Map([["spawn", "agent"]]));

    expect(part?.subagentActions).toEqual([
      expect.objectContaining({
        toolName: "completed_tool",
        toolArgs: { key: "value" },
        toolState: "success",
        toolOutput: "{\n  \"done\": true\n}",
      }),
      expect.objectContaining({
        toolName: "pending_tool",
        toolArgs: { input: "raw input" },
        toolState: "pending",
        toolOutput: "later output",
      }),
      expect.objectContaining({
        toolName: "failed_without_output",
        toolState: "failure",
        toolOutput: undefined,
        toolError: "Tool failed",
      }),
    ]);
  });

  test("marks final-answer messages complete and ignores non-final messages", () => {
    const baseParent: TranscriptRecord[] = [{
      type: "response_item",
      payload: { type: "function_call", name: "spawn_agent", call_id: "spawn" },
    }];
    const makePart = (childRecords: TranscriptRecord[]) => deriveSubagentPartsFromTranscriptRecords(
      baseParent,
      new Map([["agent", childRecords]]),
      new Map([["spawn", "agent"]]),
    )[0];

    expect(makePart([
      { type: "response_item", payload: { type: "message", phase: "commentary" } },
    ])?.toolState).toBe("pending");
    expect(makePart([
      { type: "response_item", payload: { type: "message", phase: "final_answer" } },
    ])?.toolState).toBe("success");
  });

  test("renders an event final answer without requiring a response-item copy", () => {
    const part = deriveSingleSubagent([
      {
        type: "event_msg",
        payload: {
          type: "agent_message",
          phase: "final_answer",
          message: "Event-only final answer",
        },
      },
    ]);

    expect(part?.toolState).toBe("success");
    expect(part?.subagentActions).toEqual([
      { type: "text", content: "Event-only final answer" },
    ]);
  });

  test("renders only valid multipart output text from a response final answer", () => {
    const part = deriveSingleSubagent([
      {
        type: "response_item",
        payload: { type: "message", phase: "final_answer", content: null },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          phase: "final_answer",
          content: [
            null,
            "invalid part",
            { type: "input_text", text: "Do not render input" },
            { type: "output_text" },
            { type: "output_text", text: 42 },
            { type: "output_text", text: " " },
            { type: "output_text", text: "First paragraph" },
            { type: "output_text", text: "Second paragraph" },
          ],
        },
      },
    ]);

    expect(part?.toolState).toBe("success");
    expect(part?.subagentActions).toEqual([
      { type: "text", content: "First paragraph\nSecond paragraph" },
    ]);
  });

  test("renders the readable final answer and hides encrypted collaboration messages", () => {
    const finalAnswer = "Found one correctness issue and sent the details to the parent.";
    const [part] = deriveSubagentPartsFromTranscriptRecords([
      {
        type: "response_item",
        payload: { type: "function_call", name: "spawn_agent", call_id: "spawn" },
      },
    ], new Map([["agent", [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "send_message",
          call_id: "send",
          arguments: JSON.stringify({
            target: "/root",
            message: validFernetEnvelope(),
          }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "send",
          output: "",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "agent_message",
          phase: "final_answer",
          message: finalAnswer,
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          phase: "final_answer",
          content: [{ type: "output_text", text: finalAnswer }],
        },
      },
    ]]]), new Map([["spawn", "agent"]]));

    expect(part?.toolState).toBe("success");
    expect(part?.subagentActionCount).toBe(1);
    expect(part?.subagentActions).toEqual([
      expect.objectContaining({
        type: "tool-invocation",
        toolName: "send_message",
        toolArgs: { target: "/root" },
        toolOutput: "",
      }),
      { type: "text", content: finalAnswer },
    ]);
  });

  test("redacts opaque messages only for collaboration tools", () => {
    const opaqueMessage = validFernetEnvelope();
    const part = deriveSingleSubagent([
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "send_message",
          arguments: JSON.stringify({ target: "/root", message: opaqueMessage }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "followup_task",
          arguments: JSON.stringify({ target: "/root/reviewer", message: opaqueMessage }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ task_name: "reviewer", message: opaqueMessage }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "transport_message",
          arguments: JSON.stringify({ message: opaqueMessage }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "send_message",
          arguments: JSON.stringify({ target: "/root", message: "Readable update" }),
        },
      },
    ]);

    expect(part?.subagentActions.map((action) => action.toolArgs)).toEqual([
      { target: "/root" },
      { target: "/root/reviewer" },
      { task_name: "reviewer" },
      { message: opaqueMessage },
      { target: "/root", message: "Readable update" },
    ]);
  });

  test("keeps malformed child calls visible and applies duplicate outputs to the latest call", () => {
    const part = deriveSingleSubagent([
      {
        type: "response_item",
        payload: { type: "function_call", arguments: "{}" },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: " ", arguments: "{}" },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: "missing_id", arguments: "{}" },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: "blank_id", call_id: " ", arguments: "{}" },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: "first_duplicate", call_id: "duplicate", arguments: "{}" },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: "second_duplicate", call_id: "duplicate", arguments: "{}" },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "duplicate", output: "latest output" },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", output: "ignored missing ID" },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: " ", output: "ignored blank ID" },
      },
    ]);

    expect(part?.subagentActionCount).toBe(6);
    expect(part?.subagentActions.map((action) => ({
      name: action.toolName,
      output: action.toolOutput,
    }))).toEqual([
      { name: "tool", output: undefined },
      { name: "tool", output: undefined },
      { name: "missing_id", output: undefined },
      { name: "blank_id", output: undefined },
      { name: "first_duplicate", output: undefined },
      { name: "second_duplicate", output: "latest output" },
    ]);
  });

  test("handles wait errors, aborts, malformed outputs, and success precedence", () => {
    const spawn = (agentId: string): TranscriptRecord[] => [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: `spawn-${agentId}`,
          arguments: "{}",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: `spawn-${agentId}`,
          output: JSON.stringify({ agent_id: agentId }),
        },
      },
    ];
    const wait = (callId: string, output: unknown): TranscriptRecord[] => [
      {
        type: "response_item",
        payload: { type: "function_call", name: "wait_agent", call_id: callId, arguments: "{}" },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: callId, output },
      },
    ];
    const parentRecords = [
      ...spawn("error-agent"),
      ...spawn("aborted-agent"),
      ...spawn("malformed-agent"),
      ...spawn("parent-success-agent"),
      ...spawn("child-success-agent"),
      ...wait("wait-error", JSON.stringify({ status: { "error-agent": { error: "boom" } } })),
      ...wait("wait-aborted", JSON.stringify({ status: { "aborted-agent": { aborted: true } } })),
      ...wait("wait-malformed-json", "{broken"),
      ...wait("wait-malformed-status", JSON.stringify({ status: [] })),
      ...wait("wait-non-string", { status: { "malformed-agent": { failed: "ignored" } } }),
      ...wait("wait-success", JSON.stringify({
        status: { "parent-success-agent": { completed: "done", failed: "also present" } },
      })),
      ...wait("wait-child-failure", JSON.stringify({
        status: { "child-success-agent": { failed: "parent says failure" } },
      })),
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "not-a-wait-call",
          output: JSON.stringify({ status: { "malformed-agent": { failed: "ignored" } } }),
        },
      },
    ];
    const childRecords = new Map<string, TranscriptRecord[]>([
      ["parent-success-agent", [{ type: "event_msg", payload: { type: "task_failed" } }]],
      ["child-success-agent", [{ type: "event_msg", payload: { type: "task_complete" } }]],
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(parentRecords, childRecords);
    const states = Object.fromEntries(parts.map((part) => [part.subagentId, part.toolState]));

    expect(states).toEqual({
      "error-agent": "failure",
      "aborted-agent": "failure",
      "malformed-agent": "pending",
      "parent-success-agent": "success",
      "child-success-agent": "success",
    });
  });

  test("resolves multi-agent v2 spawns through sub_agent_activity records", () => {
    const opaquePrompt = validFernetEnvelope();
    const parentRecords: TranscriptRecord[] = [
      {
        timestamp: "2026-07-17T20:43:07.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            task_name: "correctness_review",
            fork_turns: "all",
            message: opaquePrompt,
          }),
          call_id: "call-spawn-v2",
        },
      },
      {
        timestamp: "2026-07-17T20:43:08.706Z",
        type: "event_msg",
        payload: {
          type: "sub_agent_activity",
          event_id: "call-spawn-v2",
          agent_thread_id: "child-thread-v2",
          agent_path: "/root/correctness_review",
          kind: "started",
        },
      },
      {
        timestamp: "2026-07-17T20:43:08.800Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-spawn-v2",
          output: JSON.stringify({ task_name: "/root/correctness_review" }),
        },
      },
    ];
    const childRecords = new Map<string, TranscriptRecord[]>([
      ["child-thread-v2", [
        {
          timestamp: "2026-07-17T20:43:08.701Z",
          type: "session_meta",
          payload: {
            id: "child-thread-v2",
            agent_nickname: "Ptolemy",
          },
        },
        {
          timestamp: "2026-07-17T20:43:08.900Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Review the branch diff for correctness issues.",
          },
        },
        {
          timestamp: "2026-07-17T20:43:10.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "child-exec",
            input: "git diff --stat",
            status: "completed",
            output: "2 files changed",
          },
        },
        {
          timestamp: "2026-07-17T20:44:00.000Z",
          type: "event_msg",
          payload: { type: "task_complete" },
        },
      ]],
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(parentRecords, childRecords);

    expect(parts).toEqual([
      expect.objectContaining({
        subagentId: "child-thread-v2",
        subagentName: "Ptolemy",
        subagentRole: "correctness_review",
        subagentPrompt: undefined,
        subagentActionCount: 1,
        toolState: "success",
        subagentActions: [
          expect.objectContaining({
            type: "tool-invocation",
            toolName: "exec",
            toolState: "success",
            toolOutput: "2 files changed",
          }),
        ],
      }),
    ]);
  });

  test("only suppresses structurally valid Fernet prompts and never uses fork history", () => {
    const prompts = [
      validFernetEnvelope(),
      `${validFernetEnvelope()}==`,
      `${validFernetEnvelope()}=`,
      `gAAAAAB${"x".repeat(120)}`,
      "A".repeat(120),
      `${validFernetEnvelope()}!`,
      Buffer.concat([Buffer.from([0x80]), Buffer.alloc(71)]).toString("base64url"),
    ];
    const parentRecords: TranscriptRecord[] = prompts.map((message, index) => ({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        call_id: `call-${index}`,
        arguments: JSON.stringify({ message }),
      },
    }));
    const resolvedIds = new Map(prompts.map((_, index) => [`call-${index}`, `child-${index}`]));
    const childRecords = new Map(prompts.map((_, index) => [`child-${index}`, [
      { type: "event_msg", payload: {} },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "Inherited parent conversation" },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "A later follow-up" },
      },
    ]] satisfies [string, TranscriptRecord[]]));

    const parts = deriveSubagentPartsFromTranscriptRecords(parentRecords, childRecords, resolvedIds);
    expect(parts.map((part) => part.subagentPrompt)).toEqual([
      undefined,
      undefined,
      prompts[2],
      prompts[3],
      prompts[4],
      prompts[5],
      prompts[6],
    ]);
  });

  test("uses stable session metadata and the complete display-name fallback chain", () => {
    const parentRecords: TranscriptRecord[] = [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "named",
          arguments: JSON.stringify({ agent_type: "base-role", message: "Named prompt" }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "named",
          output: JSON.stringify({ agent_id: "named-id", nickname: "Base name" }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "role-only",
          arguments: JSON.stringify({ task_name: "role-name" }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: "spawn_agent", call_id: "id-only" },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: "spawn_agent", call_id: "fallback" },
      },
    ];
    const childRecords = new Map<string, TranscriptRecord[]>([[
      "named-id",
      [
        {
          type: "session_meta",
          payload: { agent_nickname: "Session name", agent_role: "session-role" },
        },
        {
          type: "session_meta",
          payload: { agent_nickname: " ", agent_role: 42 },
        },
      ],
    ]]);

    const parts = deriveSubagentPartsFromTranscriptRecords(
      parentRecords,
      childRecords,
      new Map([
        ["role-only", "role-id"],
        ["id-only", "agent-id"],
      ]),
    );

    expect(parts.map((part) => ({
      content: part.content,
      id: part.subagentId,
      name: part.subagentName,
      role: part.subagentRole,
      prompt: part.subagentPrompt,
    }))).toEqual([
      {
        content: "Session name",
        id: "named-id",
        name: "Session name",
        role: "session-role",
        prompt: "Named prompt",
      },
      { content: "role-name", id: "role-id", name: undefined, role: "role-name", prompt: undefined },
      { content: "agent-id", id: "agent-id", name: undefined, role: undefined, prompt: undefined },
      { content: "subagent", id: undefined, name: undefined, role: undefined, prompt: undefined },
    ]);
  });

  test("lets the latest terminal wait and list status win while ignoring later nonterminal refreshes", () => {
    const spawn = (callId: string, agentId: string, agentPath?: string): TranscriptRecord[] => [
      {
        type: "response_item",
        payload: { type: "function_call", name: "spawn_agent", call_id: callId },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ agent_id: agentId }),
        },
      },
      ...(agentPath ? [{
        type: "event_msg",
        payload: {
          type: "sub_agent_activity",
          event_id: callId,
          agent_thread_id: agentId,
          agent_path: agentPath,
        },
      } satisfies TranscriptRecord] : []),
    ];
    const wait = (callId: string, status: Record<string, unknown>): TranscriptRecord[] => [
      {
        type: "response_item",
        payload: { type: "function_call", name: "wait_agent", call_id: callId },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ status }),
        },
      },
    ];
    const list = (callId: string, statuses: Array<[string, unknown]>): TranscriptRecord[] => [
      {
        type: "response_item",
        payload: { type: "function_call", name: "list_agents", call_id: callId },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({
            agents: statuses.map(([agent_name, agent_status]) => ({ agent_name, agent_status })),
          }),
        },
      },
    ];
    const parentRecords = [
      ...spawn("spawn-wait-success", "wait-success"),
      ...spawn("spawn-wait-failure", "wait-failure"),
      ...spawn("spawn-list-failure", "list-failure", "/root/list-failure"),
      ...spawn("spawn-list-success", "list-success", "/root/list-success"),
      ...spawn("spawn-list-sticky", "list-sticky", "/root/list-sticky"),
      ...wait("wait-failure-first", { "wait-success": { failed: "first" } }),
      ...wait("wait-success-last", { "wait-success": { completed: "last" } }),
      ...wait("wait-success-first", { "wait-failure": { completed: "first" } }),
      ...wait("wait-failure-last", { "wait-failure": { failed: "last" } }),
      ...list("list-first", [
        ["/root/list-failure", "completed"],
        ["/root/list-success", "errored"],
        ["/root/list-sticky", "completed"],
      ]),
      ...list("list-last", [
        ["/root/list-failure", "errored"],
        ["/root/list-success", "completed"],
        ["/root/list-sticky", "running"],
      ]),
    ];

    const parts = deriveSubagentPartsFromTranscriptRecords(parentRecords, new Map());

    expect(Object.fromEntries(parts.map((part) => [part.subagentId, part.toolState]))).toEqual({
      "wait-success": "success",
      "wait-failure": "failure",
      "list-failure": "failure",
      "list-success": "success",
      "list-sticky": "success",
    });
  });

  test("derives terminal states from list_agents outputs keyed by agent path", () => {
    const spawn = (callId: string, taskName: string, threadId: string): TranscriptRecord[] => [
      {
        timestamp: "2026-07-17T20:43:07.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ task_name: taskName, message: "Do the work" }),
          call_id: callId,
        },
      },
      {
        timestamp: "2026-07-17T20:43:08.000Z",
        type: "event_msg",
        payload: {
          type: "sub_agent_activity",
          event_id: callId,
          agent_thread_id: threadId,
          agent_path: `/root/${taskName}`,
          kind: "started",
        },
      },
      {
        timestamp: "2026-07-17T20:43:08.100Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ task_name: `/root/${taskName}` }),
        },
      },
    ];
    const parentRecords: TranscriptRecord[] = [
      ...spawn("call-complete", "complete_task", "complete-thread"),
      ...spawn("call-errored", "errored_task", "errored-thread"),
      ...spawn("call-running", "running_task", "running-thread"),
      {
        timestamp: "2026-07-17T20:44:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "list_agents",
          arguments: "{}",
          call_id: "call-list",
        },
      },
      {
        timestamp: "2026-07-17T20:44:00.100Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-list",
          output: JSON.stringify({
            agents: [
              { agent_name: "/root", agent_status: "running", last_task_message: "Main thread" },
              { agent_name: "/root/complete_task", agent_status: { completed: "All done." } },
              { agent_name: "/root/errored_task", agent_status: { errored: "It broke." } },
              { agent_name: "/root/running_task", agent_status: "running" },
            ],
          }),
        },
      },
    ];

    const parts = deriveSubagentPartsFromTranscriptRecords(
      parentRecords,
      new Map<string, TranscriptRecord[]>(),
    );

    expect(parts.map((part) => [part.subagentId, part.toolState])).toEqual([
      ["complete-thread", "success"],
      ["errored-thread", "failure"],
      ["running-thread", "pending"],
    ]);
  });

  test("handles every string agent status and ignores malformed list_agents entries", () => {
    const statuses = [
      ["completed", "success"],
      ["shutdown", "success"],
      ["errored", "failure"],
      ["interrupted", "failure"],
      ["not_found", "failure"],
      ["running", "pending"],
      ["unknown", "pending"],
    ] as const;
    const parentRecords: TranscriptRecord[] = [];
    for (const [index, [status]] of statuses.entries()) {
      parentRecords.push(
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "spawn_agent",
            call_id: `spawn-${index}`,
            arguments: JSON.stringify({ message: `Task ${index}` }),
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "sub_agent_activity",
            event_id: `spawn-${index}`,
            agent_thread_id: `thread-${index}`,
            agent_path: `/root/task-${index}`,
          },
        },
      );
    }
    parentRecords.push(
      {
        type: "response_item",
        payload: { type: "function_call", name: "list_agents", call_id: "malformed-list" },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "malformed-list", output: "not-json" },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: "list_agents", call_id: "valid-list" },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "valid-list",
          output: JSON.stringify({
            agents: [
              null,
              "bad entry",
              { agent_name: "", agent_status: "completed" },
              { agent_name: 12, agent_status: "completed" },
              { agent_name: "/root/task-6", agent_status: null },
              { agent_name: "/root/task-6", agent_status: { running: true } },
              ...statuses.map(([status], index) => ({
                agent_name: `/root/task-${index}`,
                agent_status: status,
              })),
            ],
          }),
        },
      },
    );

    const parts = deriveSubagentPartsFromTranscriptRecords(parentRecords, new Map());
    expect(parts.map((part) => part.toolState)).toEqual(statuses.map(([, expected]) => expected));
  });

  test("inserts collated subagent parts without reordering existing message parts", () => {
    const merged = mergeSubagentPartsIntoMessageParts(
      [
        { type: "text", content: "First explanation." },
        { type: "tool-invocation", content: "Read" },
        { type: "text", content: "More explanation." },
      ],
      [
        { type: "subagent", content: "Lovelace" },
      ],
    );

    expect(merged).toEqual([
      { type: "text", content: "First explanation." },
      { type: "tool-invocation", content: "Read" },
      { type: "subagent", content: "Lovelace" },
      { type: "text", content: "More explanation." },
    ]);
  });

  test("prepends subagent parts when all existing parts are text", () => {
    const merged = mergeSubagentPartsIntoMessageParts(
      [
        { type: "text", content: "A" },
        { type: "text", content: "B" },
      ],
      [{ type: "subagent", content: "Sub" }],
    );

    expect(merged).toEqual([
      { type: "subagent", content: "Sub" },
      { type: "text", content: "A" },
      { type: "text", content: "B" },
    ]);
  });

  test("appends subagent parts when no parts are text", () => {
    const merged = mergeSubagentPartsIntoMessageParts(
      [
        { type: "tool-invocation", content: "Read" },
        { type: "tool-result", content: "ok" },
      ],
      [{ type: "subagent", content: "Sub" }],
    );

    expect(merged).toEqual([
      { type: "tool-invocation", content: "Read" },
      { type: "tool-result", content: "ok" },
      { type: "subagent", content: "Sub" },
    ]);
  });

  test("returns subagent parts alone when parts array is empty", () => {
    const merged = mergeSubagentPartsIntoMessageParts(
      [],
      [{ type: "subagent", content: "Sub" }],
    );

    expect(merged).toEqual([{ type: "subagent", content: "Sub" }]);
  });

  test("returns parts unchanged when subagent parts array is empty", () => {
    const parts = [
      { type: "text", content: "Hello" },
      { type: "tool-invocation", content: "Read" },
    ];
    const merged = mergeSubagentPartsIntoMessageParts(parts, []);
    expect(merged).toBe(parts);
  });
});
