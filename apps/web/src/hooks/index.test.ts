import { describe, expect, test } from "bun:test";
import { useFileSave } from "./index";

describe("hooks barrel", () => {
  test("exports the file-save hook", () => {
    expect(typeof useFileSave).toBe("function");
  });
});
