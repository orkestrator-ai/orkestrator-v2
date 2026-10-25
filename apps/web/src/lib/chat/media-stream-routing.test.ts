import { describe, expect, test } from "bun:test";
import {
  STREAMED_MEDIA_MAX_BYTES,
  mediaStreamFailure,
  mediaStreamingAvailable,
} from "@/lib/chat/media-presentation";
import { mediaStreamTarget } from "@/lib/chat/rich-markdown/media-resolver";

const page = (url: string) => {
  const parsed = new URL(url);
  return { protocol: parsed.protocol, hostname: parsed.hostname };
};

describe("mediaStreamingAvailable", () => {
  test("a loopback content origin serves loopback pages and the packaged desktop renderer", () => {
    expect(mediaStreamingAvailable("http://localhost:4999", page("http://127.0.0.1:4100/"))).toBe(
      true,
    );
    expect(mediaStreamingAvailable("http://127.0.0.1:4999", page("http://localhost:1420/"))).toBe(
      true,
    );
    expect(
      mediaStreamingAvailable("http://localhost:4999", { protocol: "file:", hostname: "" }),
    ).toBe(true);
    // A remote browser cannot reach the backend's loopback listener.
    expect(
      mediaStreamingAvailable("http://localhost:4999", page("https://host.tailnet.ts.net/")),
    ).toBe(false);
  });

  test("a hosted content origin is reachable from anywhere; none means base64", () => {
    expect(
      mediaStreamingAvailable(
        "https://artifacts.example-usercontent.net",
        page("https://host.tailnet.ts.net/"),
      ),
    ).toBe(true);
    expect(mediaStreamingAvailable(null, page("http://127.0.0.1:4100/"))).toBe(false);
    expect(mediaStreamingAvailable("not a url", page("http://127.0.0.1:4100/"))).toBe(false);
    expect(mediaStreamingAvailable("file:///tmp", page("http://127.0.0.1:4100/"))).toBe(false);
  });
});

describe("mediaStreamTarget", () => {
  test("host files need an absolute path; container files a safe workspace-relative one", () => {
    expect(mediaStreamTarget({ path: "/repo/out/clip.mp4" })).toEqual({
      path: "/repo/out/clip.mp4",
    });
    expect(mediaStreamTarget({ path: "clip.mp4", fileUrl: "file:///repo/clip%20one.mp4" })).toEqual(
      {
        path: "/repo/clip one.mp4",
      },
    );
    // A bare display name never names a live host file.
    expect(mediaStreamTarget({ path: "clip.mp4" })).toBeNull();
    expect(mediaStreamTarget({ path: "/workspace/out/a.webm", containerId: "c1" })).toEqual({
      path: "out/a.webm",
      containerId: "c1",
    });
    expect(mediaStreamTarget({ path: "out/a.webm", containerId: "c1" })).toEqual({
      path: "out/a.webm",
      containerId: "c1",
    });
    expect(mediaStreamTarget({ path: "../a.webm", containerId: "c1" })).toBeNull();
    expect(mediaStreamTarget({ path: "/etc/a.webm", containerId: "c1" })).toBeNull();
  });

  test("inline, remote and detail-reference bytes are never streamed from a live file", () => {
    expect(
      mediaStreamTarget({ path: "/repo/a.mp3", fileUrl: "data:audio/mpeg;base64,AA==" }),
    ).toBeNull();
    expect(
      mediaStreamTarget({ path: "/repo/a.mp3", fileUrl: "https://example.com/a.mp3" }),
    ).toBeNull();
    expect(mediaStreamTarget({ path: "/repo/a.mp3", detailRef: "d1" })).toBeNull();
    expect(mediaStreamTarget({ path: "a.mp3", containerId: "c1", detailRef: "d1" })).toBeNull();
    expect(mediaStreamTarget({ path: "/repo/a.mp3", fileUrl: "blob:x" })).toBeNull();
  });
});

describe("mediaStreamFailure", () => {
  const structured = (code: string) =>
    new Error(JSON.stringify({ code, message: "x", retryClass: "never" }));

  test("maps backend refusals to shown states and transport gaps to the base64 fallback", () => {
    expect(mediaStreamFailure(structured("renderer_unavailable"))).toBe("fallback");
    expect(mediaStreamFailure(structured("capacity_exceeded"))).toBe("fallback");
    expect(
      mediaStreamFailure(new Error("Unknown backend command: transcript_media_open_stream")),
    ).toBe("fallback");
    expect(mediaStreamFailure(structured("policy_denied"))).toBe("denied");
    expect(mediaStreamFailure(structured("not_found"))).toBe("unavailable");
    expect(mediaStreamFailure(structured("package_size_exceeded"))).toBe("too-large");
    expect(mediaStreamFailure(structured("unsupported_kind"))).toBe("unsupported");
  });

  test("streamed playback is bounded by the backend's maximums, not the inline bound", () => {
    expect(STREAMED_MEDIA_MAX_BYTES.host).toBe(2 * 1024 * 1024 * 1024);
    expect(STREAMED_MEDIA_MAX_BYTES.container).toBe(512 * 1024 * 1024);
  });
});
