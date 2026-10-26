import { describe, expect, test } from "bun:test";
import { normalizePersistedSessionMessages } from "./session-manager-messages.js";

function replayImage(
  mediaType: string,
  data: string,
  scope: { parent_tool_use_id?: string | null; isSidechain?: boolean } = {},
) {
  return normalizePersistedSessionMessages([
    {
      type: "user",
      uuid: "user-image",
      session_id: "session",
      parent_tool_use_id: null,
      ...scope,
      message: {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: mediaType, data } }],
      },
    },
  ]).messages;
}

describe("persisted user images", () => {
  test("excludes a sidechain user image even without a parent tool use id", () => {
    expect(replayImage("image/png", "aGVsbG8=", { isSidechain: true })).toEqual([]);
    expect(replayImage("image/png", "aGVsbG8=", { isSidechain: false })).toHaveLength(1);
  });

  test.each([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
  ])("replays %s with the live validator's whitespace normalization", (mediaType, extension) => {
    const messages = replayImage(mediaType, " \t aGVs\nbG8=\r\n ");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts).toEqual([
      {
        type: "image",
        content: `image-1.${extension}`,
        fileUrl: `data:${mediaType};base64,aGVsbG8=`,
        imageSource: "attachment",
      },
    ]);
  });

  test.each(["image/svg+xml", "image/avif", "image/bmp", "IMAGE/PNG", "text/html"])(
    "rejects a media type rejected by live prompts: %s",
    (mediaType) => {
      expect(replayImage(mediaType, "aGVsbG8=")).toEqual([]);
    },
  );

  test.each(["", " \n\t ", "abc", "aGVsbG8===", "aGVsbG8!"])(
    "rejects malformed base64: %j",
    (data) => {
      expect(replayImage("image/png", data)).toEqual([]);
    },
  );

  test("accepts exactly 8 MB and rejects one byte more", () => {
    const maximumData = Buffer.alloc(8 * 1024 * 1024, 1).toString("base64");
    const messages = replayImage("image/png", maximumData);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts[0]?.fileUrl).toBe(`data:image/png;base64,${maximumData}`);
    expect(
      replayImage("image/png", Buffer.alloc(8 * 1024 * 1024 + 1, 1).toString("base64")),
    ).toEqual([]);
  });
});
