import { describe, expect, test } from "bun:test";
import type net from "node:net";
import { installSocketTypeOfServiceGuard } from "./socket-tos-guard";

function errnoError(syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${syscall} EINVAL`), { code: "EINVAL", errno: -22, syscall });
}

function fakePrototype(setTypeOfService?: (tos: number) => unknown) {
  return { setTypeOfService } as unknown as net.Socket & {
    setTypeOfService?: (tos: number) => net.Socket;
  };
}

describe("installSocketTypeOfServiceGuard", () => {
  test("swallows setsockopt failures from a reset socket", () => {
    const proto = fakePrototype(() => {
      throw errnoError("setTypeOfService");
    });
    installSocketTypeOfServiceGuard(proto);

    expect(proto.setTypeOfService?.call(proto, 0)).toBe(proto);
  });

  test("keeps argument validation errors", () => {
    const validation = Object.assign(new RangeError("out of range"), {
      code: "ERR_OUT_OF_RANGE",
    });
    const proto = fakePrototype(() => {
      throw validation;
    });
    installSocketTypeOfServiceGuard(proto);

    expect(() => proto.setTypeOfService?.call(proto, 999)).toThrow(validation);
  });

  test("passes through successful calls and installs only once", () => {
    const calls: number[] = [];
    const proto = fakePrototype(function (this: unknown, tos: number) {
      calls.push(tos);
      return this;
    });
    installSocketTypeOfServiceGuard(proto);
    const guarded = proto.setTypeOfService;
    installSocketTypeOfServiceGuard(proto);

    expect(proto.setTypeOfService).toBe(guarded);
    expect(proto.setTypeOfService?.call(proto, 16)).toBe(proto);
    expect(calls).toEqual([16]);
  });

  test("is a no-op when the runtime has no setTypeOfService", () => {
    const proto = fakePrototype();
    installSocketTypeOfServiceGuard(proto);

    expect(proto.setTypeOfService).toBeUndefined();
  });
});
