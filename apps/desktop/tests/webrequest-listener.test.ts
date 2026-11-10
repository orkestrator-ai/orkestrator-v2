import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { answering, observing } from "../electron/webrequest-listener";

type Details = { url: string };
type Response = { cancel?: boolean; requestHeaders?: Record<string, string> };

const DETAILS: Details = { url: "https://desk.example/private?token=secret-value" };

let capture = captureLogs();
afterEach(() => {
  capture.restore();
  capture = captureLogs();
});

function lines(): string[] {
  return capture.outputs.map((output) => output.line);
}

/** Every line, joined: nothing in it may name the request or the error message. */
function expectContentFree(): void {
  const text = lines().join("\n");
  expect(text).not.toContain("desk.example");
  expect(text).not.toContain("secret-value");
  expect(text).not.toContain("window is gone");
}

describe("answering", () => {
  test("answers once with a synchronous decision", () => {
    const callback = mock((_response: Response) => undefined);
    answering<Details, Response>(
      "fixture",
      () => ({ requestHeaders: { Accept: "*/*" } }),
      () => ({ cancel: true }),
    )(DETAILS, callback);
    expect(callback.mock.calls).toEqual([[{ requestHeaders: { Accept: "*/*" } }]]);
    expect(lines()).toEqual([]);
  });

  test("a throwing decision answers its fail-closed response, naming only the listener", () => {
    const callback = mock((_response: Response) => undefined);
    const failClosed = mock((details: Details) => {
      expect(details).toBe(DETAILS);
      return { cancel: true };
    });
    answering<Details, Response>(
      "fixture.before-request",
      () => {
        throw new Error(`window is gone: ${DETAILS.url}`);
      },
      failClosed,
    )(DETAILS, callback);
    expect(callback.mock.calls).toEqual([[{ cancel: true }]]);
    expect(failClosed).toHaveBeenCalledTimes(1);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("[desktop.webrequest] listener.failed-closed");
    expect(lines()[0]).toContain("scope=fixture.before-request kind=Error");
    expectContentFree();
  });

  test("a throwing fail-closed response still answers, by cancelling", () => {
    const callback = mock((_response: Response) => undefined);
    answering<Details, Response>(
      "fixture",
      () => {
        throw new Error("window is gone");
      },
      () => {
        throw new Error("window is gone");
      },
    )(DETAILS, callback);
    expect(callback.mock.calls).toEqual([[{ cancel: true }]]);
  });

  test("an asynchronous decision answers when it settles", async () => {
    const callback = mock((_response: Response) => undefined);
    const { promise, resolve } = Promise.withResolvers<Response>();
    answering<Details, Response>(
      "fixture",
      () => promise,
      () => ({ cancel: true }),
    )(DETAILS, callback);
    expect(callback).not.toHaveBeenCalled();
    resolve({});
    await promise;
    await Promise.resolve();
    expect(callback.mock.calls).toEqual([[{}]]);
  });

  test("a rejected decision answers its fail-closed response", async () => {
    const callback = mock((_response: Response) => undefined);
    const rejected = Promise.reject(new Error("window is gone"));
    answering<Details, Response>(
      "fixture",
      () => rejected,
      () => ({ cancel: true }),
    )(DETAILS, callback);
    await rejected.catch(() => undefined);
    await Promise.resolve();
    expect(callback.mock.calls).toEqual([[{ cancel: true }]]);
    expect(lines().join("\n")).toContain("listener.failed-closed");
    expectContentFree();
  });

  test("a thenable whose then throws still answers", () => {
    const callback = mock((_response: Response) => undefined);
    const broken = {
      then() {
        throw new Error("window is gone");
      },
    } as unknown as PromiseLike<Response>;
    answering<Details, Response>(
      "fixture",
      () => broken,
      () => ({ cancel: true }),
    )(DETAILS, callback);
    expect(callback.mock.calls).toEqual([[{ cancel: true }]]);
  });

  test("a throwing callback is contained and never answered twice", () => {
    const callback = mock((_response: Response) => {
      throw new Error("window is gone");
    });
    expect(() =>
      answering<Details, Response>(
        "fixture",
        () => ({}),
        () => ({ cancel: true }),
      )(DETAILS, callback),
    ).not.toThrow();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(lines().join("\n")).toContain("callback.failed");
    expectContentFree();
  });

  test("repeated failures are throttled, then a success reports recovery", () => {
    const failing = answering<Details, Response>(
      "fixture",
      () => {
        throw new Error("window is gone");
      },
      () => ({ cancel: true }),
    );
    for (let index = 0; index < 50; index += 1) failing(DETAILS, () => undefined);
    expect(lines()).toHaveLength(1);
    answering<Details, Response>(
      "fixture",
      () => ({}),
      () => ({ cancel: true }),
    )(DETAILS, () => undefined);
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toContain("throttle.recovered");
  });
});

describe("observing", () => {
  test("passes details through and does nothing else when the observer succeeds", () => {
    const onFailure = mock((_details: Details) => undefined);
    const observe = mock((_details: Details) => undefined);
    observing("fixture.redirect", observe, onFailure)(DETAILS);
    expect(observe).toHaveBeenCalledWith(DETAILS);
    expect(onFailure).not.toHaveBeenCalled();
    expect(lines()).toEqual([]);
  });

  test("a throwing observer runs its fallback instead of throwing into main", () => {
    const onFailure = mock((_details: Details) => undefined);
    expect(() =>
      observing(
        "fixture.redirect",
        () => {
          throw new Error("window is gone");
        },
        onFailure,
      )(DETAILS),
    ).not.toThrow();
    expect(onFailure).toHaveBeenCalledWith(DETAILS);
    expect(lines()[0]).toContain("[desktop.webrequest] observer.failed");
    expectContentFree();
  });

  test("a throwing fallback is contained too", () => {
    expect(() =>
      observing(
        "fixture.redirect",
        () => {
          throw new Error("window is gone");
        },
        () => {
          throw new Error("window is gone");
        },
      )(DETAILS),
    ).not.toThrow();
  });
});
