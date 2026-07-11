import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createUuid } from "./uuid";

describe("createUuid", () => {
  let randomSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    randomSpy?.mockRestore();
    randomSpy = undefined;
  });

  test("uses the native randomUUID implementation when available", () => {
    const randomUUID = () => "12345678-1234-4234-9234-123456789abc" as `${string}-${string}-${string}-${string}-${string}`;

    expect(createUuid({ randomUUID })).toBe("12345678-1234-4234-9234-123456789abc");
  });

  test("creates a version 4 UUID when randomUUID is unavailable", () => {
    const getRandomValues: Crypto["getRandomValues"] = (array) => {
      const bytes = array as unknown as Uint8Array;
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = index;
      }
      return array;
    };

    const uuid = createUuid({ getRandomValues });

    expect(uuid).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  test("creates a version 4 UUID when the Crypto API is unavailable", () => {
    randomSpy = spyOn(Math, "random").mockReturnValue(0);

    const uuid = createUuid({});

    expect(uuid).toBe("00000000-0000-4000-8000-000000000000");
    expect(randomSpy).toHaveBeenCalledTimes(16);
  });
});
