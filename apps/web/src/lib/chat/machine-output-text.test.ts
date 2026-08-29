import { describe, expect, test } from "bun:test";
import {
  isWithheldMachineOutput,
  jsonDocumentState,
  lastMachineJsonDocument,
} from "./machine-output-text";

describe("jsonDocumentState", () => {
  test("treats ordinary prose as prose", () => {
    expect(jsonDocumentState("Inspecting the changed files.")).toBe("not-json");
    expect(jsonDocumentState("")).toBe("not-json");
    expect(jsonDocumentState("   ")).toBe("not-json");
    expect(jsonDocumentState("HEAD matches `origin/main`.")).toBe("not-json");
  });

  test("recognizes a finished JSON document", () => {
    expect(jsonDocumentState('{"reviewScope":{"targetBranch":"main"}}')).toBe("complete");
    expect(jsonDocumentState("[1, 2, 3]")).toBe("complete");
    expect(jsonDocumentState('  {"a":1}  \n')).toBe("complete");
  });

  test("recognizes adjacent JSON progress responses as one machine-output sequence", () => {
    const first = '{"complete":false,"rationale":"Tests are still running."}';
    const final = '{"complete":true,"rationale":"All tests passed."}';

    expect(jsonDocumentState(`${first}${final}`)).toBe("complete");
    expect(jsonDocumentState(`${first}${final.slice(0, -1)}`)).toBe("incomplete");
    expect(lastMachineJsonDocument(`${first}${final}`)).toBe(final);
    expect(lastMachineJsonDocument(`${first}${final.slice(0, -1)}`)).toBeNull();
  });

  test("keeps newline-separated and fenced JSON sequences visible as source", () => {
    const first = '{"file":"a.ts"}';
    const second = '{"file":"b.ts"}';

    expect(jsonDocumentState(`${first}\n${second}`)).toBe("not-json");
    expect(jsonDocumentState(`\`\`\`json\n${first}${second}\n\`\`\``)).toBe("not-json");
    expect(jsonDocumentState(`\`\`\`json\n${first}\n\`\`\`\n\`\`\`json\n${second}\n\`\`\``)).toBe(
      "not-json",
    );
    expect(lastMachineJsonDocument(`${first}\n${second}`)).toBeNull();
  });

  test("recognizes a document that is still streaming", () => {
    // Exactly what a provider drafting a report into the text channel looks
    // like on every poll before the turn ends.
    expect(jsonDocumentState('{"reviewScope":{"targetBranch":"cursor-conn')).toBe("incomplete");
    expect(jsonDocumentState("[")).toBe("incomplete");
    expect(jsonDocumentState('{"issues":[{"title":"Something",')).toBe("incomplete");
  });

  test("does not let a brace inside a string close the document", () => {
    expect(jsonDocumentState('{"reason":"a } inside a string"')).toBe("incomplete");
    expect(jsonDocumentState('{"reason":"a } inside a string"}')).toBe("complete");
    expect(jsonDocumentState('{"reason":"escaped \\" quote"}')).toBe("complete");
  });

  test("keeps prose that merely contains or follows JSON", () => {
    expect(jsonDocumentState('{"a":1} and then some commentary')).toBe("not-json");
    expect(jsonDocumentState('Here is the payload: {"a":1}')).toBe("not-json");
    expect(jsonDocumentState("} stray closing brace")).toBe("not-json");
    expect(lastMachineJsonDocument('{"a":1} and then some commentary')).toBeNull();
  });

  test("sees through a JSON code fence", () => {
    expect(jsonDocumentState('```json\n{"a":1}\n```')).toBe("complete");
    expect(jsonDocumentState('```\n{"a":1,')).toBe("incomplete");
    expect(lastMachineJsonDocument('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(lastMachineJsonDocument('```json\n{"a":1,\n```')).toBeNull();
  });

  test("classifies a malformed but closed document as machine output", () => {
    // Grammar is not validated: a closed document is the provider's answer
    // whether or not it parses, and must not render as prose either way.
    expect(jsonDocumentState('{"a": bad}')).toBe("complete");
  });
});

describe("isWithheldMachineOutput", () => {
  test("withholds finished and streaming documents, keeps prose", () => {
    expect(isWithheldMachineOutput('{"a":1}')).toBe(true);
    expect(isWithheldMachineOutput('{"a":1,"b":')).toBe(true);
    expect(isWithheldMachineOutput("Reviewing the diff now.")).toBe(false);
  });

  test("scans a large draft without parsing it", () => {
    const draft = `{"issues":[${Array.from(
      { length: 5_000 },
      (_, index) => `{"title":"finding ${index}","line":${index}}`,
    ).join(",")}`;
    expect(draft.length).toBeGreaterThan(100_000);
    expect(jsonDocumentState(draft)).toBe("incomplete");
    expect(isWithheldMachineOutput(`${draft}]}`)).toBe(true);
  });
});
