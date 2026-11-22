import { describe, expect, test } from "bun:test";
import { nextNumber, numbersIn } from "../../../scripts/number-claims";

// "The next number after the highest in use" let two branches cut from the
// same main claim the same to-do or flake number.

describe("number:next", () => {
  test("reads numbers from file and claim names, not the index", () => {
    expect(
      numbersIn(["0000-index.md", "8314-follow-ups.md", "10009", "README.md", "area/0741-x.md"]),
    ).toEqual([8314, 10009, 741]);
  });

  test("steps a random 1 to spread above the highest", () => {
    expect(nextNumber(8314, { spread: 10, random: () => 0 })).toBe("8315");
    expect(nextNumber(8314, { spread: 10, random: () => 0.999 })).toBe("8324");
    expect(nextNumber(41, { random: () => 0 })).toBe("0042");
  });

  test("stays within the register's digits", () => {
    expect(nextNumber(9995, { spread: 10, maxDigits: 4, random: () => 0.999 })).toBe("9999");
    expect(() => nextNumber(9999, { maxDigits: 4 })).toThrow("4 digits");
    expect(nextNumber(10009, { spread: 1 })).toBe("10010");
  });
});
