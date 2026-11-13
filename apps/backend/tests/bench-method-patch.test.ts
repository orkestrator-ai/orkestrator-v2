import { describe, expect, test } from "bun:test";

import { patchMethod } from "../scripts/bench-method-patch.js";

class Service {
  value(): string {
    return "prototype";
  }
}

describe("patchMethod", () => {
  test("restores the prototype's method when the measurement throws", async () => {
    const service = new Service();
    const restore = patchMethod(service, "value", () => "patched");
    expect(service.value()).toBe("patched");
    // A later reassignment (the bench switches variants per pass) is undone too.
    service.value = () => "switched";
    const measure = async () => {
      try {
        throw new Error("2 owed wakes were not delivered");
      } finally {
        restore();
      }
    };
    await expect(measure()).rejects.toThrow("were not delivered");
    expect(Object.hasOwn(service, "value")).toBe(false);
    expect(service.value()).toBe("prototype");
  });

  test("puts back an own property exactly as it was", () => {
    const original = () => "own";
    const target = { value: original };
    const restore = patchMethod(target, "value", () => "patched");
    restore();
    expect(target.value).toBe(original);
  });
});
