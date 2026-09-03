import { describe, expect, test } from "bun:test";
import { expandTailscaleMachineName } from "./connections.js";

describe("expandTailscaleMachineName", () => {
  test("reuses the first known ts.net suffix for a bare machine name", () => {
    expect(
      expandTailscaleMachineName("workstation", [
        "https://laptop.bagrid-gobline.ts.net",
        "https://other.second-tailnet.ts.net",
      ]),
    ).toBe("workstation.bagrid-gobline.ts.net");
  });

  test("leaves complete addresses, localhost, and unknown bare names alone", () => {
    expect(expandTailscaleMachineName("https://desk.example", ["https://a.tailnet.ts.net"])).toBe(
      "https://desk.example",
    );
    expect(expandTailscaleMachineName("localhost", ["https://a.tailnet.ts.net"])).toBe("localhost");
    expect(expandTailscaleMachineName("workstation", [])).toBe("workstation");
  });
});
