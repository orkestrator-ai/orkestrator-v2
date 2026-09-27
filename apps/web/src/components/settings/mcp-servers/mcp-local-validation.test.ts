import { describe, expect, test } from "bun:test";

import {
  definitionInputFromDraft,
  draftFromDefinition,
  emptyDraft,
  newMapRow,
  patchFromDraft,
} from "./mcp-draft";
import { localAddErrors, localPatchErrors } from "./mcp-local-validation";
import { SECRET, capabilities, editableDocs } from "./mcp-test-fixtures";

function addErrors(draft: ReturnType<typeof emptyDraft>) {
  return localAddErrors(draft, definitionInputFromDraft(draft, true), capabilities);
}

describe("local MCP form validation", () => {
  test("a valid stdio draft has no errors", () => {
    const draft = { ...emptyDraft("stdio"), name: "files" };
    draft.command = { kind: "set", value: "/opt/My Tools/files" };
    expect(addErrors(draft)).toEqual([]);
  });

  test("name rule, required command and env key grammar are checked", () => {
    const draft = { ...emptyDraft("stdio"), name: "bad name" };
    draft.env = [{ ...newMapRow(), key: "1BAD", value: SECRET }];
    const errors = addErrors(draft);
    expect(errors.map((error) => error.field)).toEqual(
      expect.arrayContaining(["name", "command", "env.0.key"]),
    );
    expect(JSON.stringify(errors)).not.toContain(SECRET);
  });

  test("remote drafts check the URL and headers without echoing values", () => {
    const draft = { ...emptyDraft("http"), name: "remote" };
    draft.url = { kind: "set", value: `https://user:${SECRET}@example.com/mcp` };
    draft.headers = [{ ...newMapRow(), key: "", value: SECRET }];
    const errors = addErrors(draft);
    expect(errors).toEqual(
      expect.arrayContaining([
        { field: "url", message: "Must not embed a user name or password; use a header instead." },
        { field: "headers", message: "Every header needs a name." },
      ]),
    );
    expect(JSON.stringify(errors)).not.toContain(SECRET);
  });

  test("Orkestrator's own names and credentials are refused locally", () => {
    const draft = { ...emptyDraft("stdio"), name: "files" };
    draft.command = { kind: "set", value: "files" };
    draft.env = [{ ...newMapRow(), key: "TOKEN", value: "${ORKESTRATOR_AGENT_MCP_TOKEN}" }];
    expect(addErrors(draft).some((error) => error.field.startsWith("env."))).toBe(true);
  });

  test("edits are checked on the minimal patch", () => {
    const draft = {
      ...draftFromDefinition(editableDocs),
      command: { kind: "set" as const, value: "" },
    };
    const errors = localPatchErrors(draft, patchFromDraft(editableDocs, draft));
    expect(errors).toEqual([{ field: "command", message: "Must not be empty." }]);
  });
});
