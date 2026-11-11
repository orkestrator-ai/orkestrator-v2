import { expect, test } from "bun:test";
import { openCode2RevertMarker, openCode2RevertNotice } from "./revert.js";

test("the staged-revert notice is an info advisory keyed by the marker", () => {
  expect(openCode2RevertNotice(undefined)).toEqual([]);
  const [notice] = openCode2RevertNotice({ messageId: "msg_1" });
  expect(notice).toMatchObject({
    kind: "advisory",
    severity: "info",
    occurrenceId: "opencode-revert:msg_1:",
  });
  expect(openCode2RevertNotice({ messageId: "msg_2" })[0]!.occurrenceId).not.toBe(
    notice!.occurrenceId,
  );
});

test("reads Session.revert and ignores a missing or malformed one", () => {
  expect(openCode2RevertMarker({ revert: { messageID: "msg_1" } })).toEqual({ messageId: "msg_1" });
  for (const session of [undefined, {}, { revert: null }, { revert: { messageID: "user-1" } }]) {
    expect(openCode2RevertMarker(session)).toBeUndefined();
  }
});
