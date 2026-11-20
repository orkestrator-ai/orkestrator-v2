import { expect, test } from "bun:test";
import { machineInitials } from "./machine-initials";

test("a hyphenated name takes one letter of the first part and two of the second", () => {
  expect(machineInitials("omarchy-hp")).toBe("OHP");
  expect(machineInitials("omarchy-gram")).toBe("OGR");
  expect(machineInitials("rk_mbp")).toBe("RMB");
});

test("three or more parts take one letter of each of the first three", () => {
  expect(machineInitials("dev-box-eu-west")).toBe("DBE");
});

test("a name ending in a digit takes two letters plus the digit", () => {
  expect(machineInitials("beelink2")).toBe("BE2");
  expect(machineInitials("mbp3")).toBe("MB3");
  expect(machineInitials("node12")).toBe("N12");
});

test("otherwise its first three letters, upper case", () => {
  expect(machineInitials("mini")).toBe("MIN");
  expect(machineInitials("rkmbp")).toBe("RKM");
  expect(machineInitials("beelink")).toBe("BEE");
  expect(machineInitials("pi")).toBe("PI");
});

test("a name of digits only or with no usable characters still gives a label", () => {
  expect(machineInitials("1234")).toBe("123");
  expect(machineInitials("--")).toBe("?");
  expect(machineInitials("")).toBe("?");
});
