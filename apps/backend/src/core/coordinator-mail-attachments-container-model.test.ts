import { describe, expect, test } from "bun:test";

import {
  OPEN_IMAGE_CALL,
  messagesResponse,
  scriptedReply,
  type ModelRecord,
} from "./coordinator-mail-attachments-container-model-test-support.js";

const carrier = (payload: unknown) =>
  `Mail arrived.\n<orkestrator-peer-payload-json>\n${JSON.stringify(payload)}\n</orkestrator-peer-payload-json>`;

const fresh = (): ModelRecord => ({ calls: 0, asked: null, images: [] });

describe("the in-container scripted model for the mailed-image read", () => {
  test("asks for Read on the path the mail carrier names", () => {
    const record = fresh();
    const reply = scriptedReply(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: carrier({ attachments: [{ path: "/workspace/.orkestrator/m/a.png" }] }),
              },
            ],
          },
        ],
      },
      record,
    );
    expect(reply).toEqual([
      {
        type: "tool_use",
        id: OPEN_IMAGE_CALL,
        name: "Read",
        input: { file_path: "/workspace/.orkestrator/m/a.png" },
      },
    ]);
    expect(record).toEqual({ calls: 1, asked: "/workspace/.orkestrator/m/a.png", images: [] });
  });

  test("records the image returned for its call and ends the turn", () => {
    const record = fresh();
    const reply = scriptedReply(
      {
        messages: [
          { role: "user", content: carrier({ attachments: [{ path: "/x.png" }] }) },
          { role: "assistant", content: [{ type: "text", text: "" }] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: OPEN_IMAGE_CALL,
                content: [{ type: "image", source: { type: "base64", data: "iVBOR" } }],
              },
            ],
          },
        ],
      },
      record,
    );
    expect(reply).toEqual([{ type: "text", text: "Seen." }]);
    expect(record.images).toEqual(["iVBOR"]);
  });

  test("answers without a tool when no path is named or the carrier is malformed", () => {
    const record = fresh();
    expect(scriptedReply({ messages: [{ role: "user", content: "hello" }] }, record)).toEqual([
      { type: "text", text: "No path in the message." },
    ]);
    const malformed =
      "<orkestrator-peer-payload-json>\n{not json\n</orkestrator-peer-payload-json>";
    expect(scriptedReply({ messages: [{ role: "user", content: malformed }] }, record)).toEqual([
      { type: "text", text: "No path in the message." },
    ]);
    expect(record).toEqual({ calls: 2, asked: null, images: [] });
  });

  test("streams a tool call as the Messages API event stream", async () => {
    const response = messagesResponse(
      { stream: true, model: "m" },
      [{ type: "tool_use", id: OPEN_IMAGE_CALL, name: "Read", input: { file_path: "/a" } }],
      "msg_1",
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toContain('"stop_reason":"tool_use"');
    expect(text).toContain('"partial_json":"{\\"file_path\\":\\"/a\\"}"');
    const json = await messagesResponse(
      { model: "m" },
      [{ type: "text", text: "ok" }],
      "m2",
    ).json();
    expect(json).toMatchObject({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
    });
  });
});
