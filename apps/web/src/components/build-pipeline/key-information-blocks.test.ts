import { describe, expect, test } from "bun:test";
import {
  keyInformationBlocks,
  REGROUP_MIN_LENGTH,
  regroupSentences,
} from "./key-information-blocks";

describe("keyInformationBlocks", () => {
  test("returns nothing for blank text", () => {
    expect(keyInformationBlocks("  \n\n ")).toEqual([]);
  });

  test("keeps short single-line text as one paragraph", () => {
    expect(keyInformationBlocks("  One short line.  ")).toEqual([
      { kind: "paragraph", text: "One short line." },
    ]);
  });

  test("splits paragraphs on blank lines and keeps soft line breaks", () => {
    expect(keyInformationBlocks("First line\nstill first.\n\n\r\nSecond.")).toEqual([
      { kind: "paragraph", text: "First line\nstill first." },
      { kind: "paragraph", text: "Second." },
    ]);
  });

  test("turns bullet lines into a list between paragraphs", () => {
    expect(
      keyInformationBlocks(
        "It now does three things:\n- one\n* two\n• three\nAfterwards it stops.",
      ),
    ).toEqual([
      { kind: "paragraph", text: "It now does three things:" },
      { kind: "list", ordered: false, items: ["one", "two", "three"] },
      { kind: "paragraph", text: "Afterwards it stops." },
    ]);
  });

  test("turns numbered lines into an ordered list and starts a new list on a marker change", () => {
    expect(keyInformationBlocks("1. first\n2) second\n- loose")).toEqual([
      { kind: "list", ordered: true, items: ["first", "second"] },
      { kind: "list", ordered: false, items: ["loose"] },
    ]);
  });

  test("joins an indented line onto the bullet above it", () => {
    expect(keyInformationBlocks("- a long item\n  that wraps\n- next")).toEqual([
      { kind: "list", ordered: false, items: ["a long item that wraps", "next"] },
    ]);
  });

  test("does not mistake a hyphenated word or bold marker for a bullet", () => {
    expect(keyInformationBlocks("-flag stays\n*emphasis* too")).toEqual([
      { kind: "paragraph", text: "-flag stays\n*emphasis* too" },
    ]);
  });

  test("regroups one long unbroken run into paragraphs of whole sentences", () => {
    const sentence = (n: number) =>
      `Sentence ${n} explains one more part of the change in enough words to matter here.`;
    const text = Array.from({ length: 12 }, (_, i) => sentence(i + 1)).join(" ");
    const blocks = keyInformationBlocks(text);
    expect(blocks.length).toBeGreaterThan(2);
    for (const block of blocks) {
      expect(block.kind).toBe("paragraph");
      if (block.kind === "paragraph") {
        expect(block.text.startsWith("Sentence ")).toBe(true);
        expect(block.text.endsWith("matter here.")).toBe(true);
      }
    }
    // Nothing is lost or reordered.
    expect(blocks.map((block) => (block.kind === "paragraph" ? block.text : "")).join(" ")).toBe(
      text,
    );
  });

  test("shows text with any line break as written, even when long", () => {
    const long = "A sentence that goes on. ".repeat(40).trim();
    expect(keyInformationBlocks(`${long}\n\nEnd.`)).toEqual([
      { kind: "paragraph", text: long },
      { kind: "paragraph", text: "End." },
    ]);
  });
});

describe("regroupSentences", () => {
  test("leaves text below the threshold alone", () => {
    const text = "One. Two. Three. Four.";
    expect(text.length).toBeLessThan(REGROUP_MIN_LENGTH);
    expect(regroupSentences(text)).toEqual([text]);
  });

  test("leaves long text with too few sentences alone", () => {
    const text = `${"word ".repeat(120).trim()}. Then one more.`;
    expect(regroupSentences(text)).toEqual([text]);
  });

  test("does not split inside file names, versions, abbreviations or lowercase continuations", () => {
    const filler = "This sentence pads the text so that it is long enough to be regrouped at all.";
    const tricky =
      "It edits a.ts and v1.2 builds, e.g. Bun and Node, and the rest vs. Deno. it ended.";
    const text = [filler, filler, tricky, filler, filler, filler, filler].join(" ");
    const paragraphs = regroupSentences(text);
    expect(paragraphs.some((paragraph) => paragraph.includes(tricky))).toBe(true);
  });

  test("keeps a closing bracket or quote with its sentence", () => {
    const filler = "This sentence pads the text so that it is long enough to be regrouped at all.";
    const text = [
      filler,
      filler,
      filler,
      'It said "done." (See report 0430.)',
      filler,
      filler,
      filler,
    ].join(" ");
    const paragraphs = regroupSentences(text);
    expect(paragraphs.join(" ")).toBe(text);
    for (const paragraph of paragraphs) {
      expect(paragraph.startsWith(")")).toBe(false);
      expect(paragraph.startsWith('"')).toBe(false);
    }
  });

  test("folds a short trailing sentence into the paragraph before it", () => {
    const filler = "This sentence pads the text so that it is long enough to be regrouped at all.";
    const text = [filler, filler, filler, filler, filler, filler, filler, "Done."].join(" ");
    const paragraphs = regroupSentences(text);
    expect(paragraphs.at(-1)!.endsWith(`${filler} Done.`)).toBe(true);
  });
});
