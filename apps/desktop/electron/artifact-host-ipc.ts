import {
  ARTIFACT_FRAME_CHANNEL,
  type ArtifactThemeMessage,
} from "@orkestrator/protocol/artifact-frame-channel";
import {
  ARTIFACT_HOST_CHANNELS,
  type ArtifactHostBounds,
  type ArtifactHostOpenInput,
} from "@orkestrator/protocol/artifact-host-ipc";

/** Main-process surface behind `window.orkestrator.artifactHost` for one window. */
export type ArtifactHostController = {
  open(input: ArtifactHostOpenInput): Promise<{ ok: true } | { ok: false; error: string }>;
  setBounds(hostId: string, bounds: ArtifactHostBounds): void;
  setVisible(hostId: string, visible: boolean): void;
  postTheme(hostId: string, theme: ArtifactThemeMessage): void;
  close(hostId: string): void;
};

type HandleLike<E> = (channel: string, listener: (event: E, ...args: unknown[]) => unknown) => void;

const HOST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const IDENTITY_TOKEN = /^[A-Za-z0-9_.:-]{1,256}$/;
/** Matches the frame runtime's readiness nonce rule in `parseArtifactFrameMessage`. */
const READINESS_NONCE = /^[A-Za-z0-9_-]{8,64}$/;
const THEME_TOKEN_KEY = /^--[a-z0-9-]{1,40}$/;
const MAX_CONTENT_URL_LENGTH = 4_096;
const MAX_THEME_TOKENS = 64;
const MAX_THEME_TOKEN_VALUE = 200;
const MAX_COORDINATE = 1_000_000;

function plainRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${what}`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], what: string): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error(`Unexpected field in ${what}`);
  }
}

export function artifactHostId(value: unknown): string {
  if (typeof value !== "string" || !HOST_ID.test(value)) {
    throw new Error("Expected an artifact host ID");
  }
  return value;
}

export function artifactHostVisible(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Expected artifact host visibility");
  return value;
}

export function artifactHostBounds(value: unknown): ArtifactHostBounds {
  const record = plainRecord(value, "artifact host bounds");
  const { x, y, width, height } = record;
  const values = [x, y, width, height];
  if (
    !values.every(
      (item) =>
        typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= MAX_COORDINATE,
    ) ||
    (width as number) < 0 ||
    (height as number) < 0
  ) {
    throw new Error("Expected finite artifact host bounds");
  }
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

/**
 * A capability URL on the dedicated content origin: http(s), no embedded
 * credentials, no fragment, and never the application renderer's own origin.
 */
export function artifactContentUrl(value: unknown, trustedRendererUrl?: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CONTENT_URL_LENGTH) {
    throw new Error("Expected an artifact content URL");
  }
  if (/[\u0000- \u007f-\u009f]/.test(value)) throw new Error("Expected an artifact content URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Expected an artifact content URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Expected an HTTP(S) artifact content URL");
  }
  if (url.username || url.password)
    throw new Error("Artifact content URLs cannot carry credentials");
  if (url.hash) throw new Error("Artifact content URLs cannot carry a fragment");
  if (!url.hostname) throw new Error("Expected an artifact content URL");
  if (trustedRendererUrl) {
    try {
      if (new URL(trustedRendererUrl).origin === url.origin) {
        throw new Error("Artifact content cannot share the application origin");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Artifact content")) throw error;
    }
  }
  return url.href;
}

export function artifactHostOpenInput(
  value: unknown,
  trustedRendererUrl?: string,
): ArtifactHostOpenInput {
  const record = plainRecord(value, "artifact host details");
  onlyKeys(
    record,
    [
      "hostId",
      "contentUrl",
      "artifactId",
      "revision",
      "generation",
      "readinessNonce",
      "bounds",
      "visible",
    ],
    "artifact host details",
  );
  const { artifactId, revision, generation, readinessNonce } = record;
  if (typeof artifactId !== "string" || !IDENTITY_TOKEN.test(artifactId)) {
    throw new Error("Expected an artifact ID");
  }
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Expected an artifact revision");
  }
  if (typeof generation !== "string" || !IDENTITY_TOKEN.test(generation)) {
    throw new Error("Expected an artifact document generation");
  }
  if (typeof readinessNonce !== "string" || !READINESS_NONCE.test(readinessNonce)) {
    throw new Error("Expected an artifact readiness nonce");
  }
  return {
    hostId: artifactHostId(record.hostId),
    contentUrl: artifactContentUrl(record.contentUrl, trustedRendererUrl),
    artifactId,
    revision,
    generation,
    readinessNonce,
    bounds: artifactHostBounds(record.bounds),
    visible: artifactHostVisible(record.visible),
  };
}

/** Exactly the presentation fields of `ArtifactThemeMessage`, bounded like the frame runtime reads them. */
export function artifactThemeMessage(value: unknown): ArtifactThemeMessage {
  const record = plainRecord(value, "an artifact theme message");
  onlyKeys(
    record,
    [
      "channel",
      "v",
      "type",
      "artifactId",
      "revision",
      "generation",
      "appearance",
      "reducedMotion",
      "viewport",
      "tokens",
    ],
    "an artifact theme message",
  );
  const { channel, v, type, artifactId, revision, generation, appearance, reducedMotion } = record;
  if (channel !== ARTIFACT_FRAME_CHANNEL || v !== 1 || type !== "theme") {
    throw new Error("Expected an artifact theme message");
  }
  if (typeof artifactId !== "string" || !IDENTITY_TOKEN.test(artifactId)) {
    throw new Error("Expected an artifact ID");
  }
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Expected an artifact revision");
  }
  if (typeof generation !== "string" || !IDENTITY_TOKEN.test(generation)) {
    throw new Error("Expected an artifact document generation");
  }
  if (appearance !== "light" && appearance !== "dark")
    throw new Error("Expected a theme appearance");
  if (typeof reducedMotion !== "boolean") throw new Error("Expected a reduced-motion preference");
  const viewport = plainRecord(record.viewport, "a theme viewport");
  onlyKeys(viewport, ["width", "height"], "a theme viewport");
  const { width, height } = viewport;
  if (
    ![width, height].every(
      (item) =>
        typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= MAX_COORDINATE,
    )
  ) {
    throw new Error("Expected a finite theme viewport");
  }
  const tokensRecord = plainRecord(record.tokens, "theme tokens");
  const entries = Object.entries(tokensRecord);
  if (entries.length > MAX_THEME_TOKENS) throw new Error("Too many theme tokens");
  const tokens: Record<string, string> = {};
  for (const [key, tokenValue] of entries) {
    if (
      !THEME_TOKEN_KEY.test(key) ||
      typeof tokenValue !== "string" ||
      tokenValue.length >= MAX_THEME_TOKEN_VALUE ||
      /[\u0000-\u001f\u007f]/.test(tokenValue)
    ) {
      throw new Error("Expected bounded theme tokens");
    }
    tokens[key] = tokenValue;
  }
  return {
    channel: ARTIFACT_FRAME_CHANNEL,
    v: 1,
    type: "theme",
    artifactId,
    revision,
    generation,
    appearance,
    reducedMotion,
    viewport: { width: width as number, height: height as number },
    tokens,
  };
}

/**
 * Register the artifact-host channels on an already sender-checked `handle`
 * (see `registerMainIpc`). Each call resolves the controller of the window
 * that sent it, so one window can never position or close another's host.
 */
export function registerArtifactHostIpc<E>({
  handle,
  getController,
  trustedRendererUrl,
}: {
  handle: HandleLike<E>;
  getController: (event: E) => ArtifactHostController | null;
  trustedRendererUrl?: string;
}): void {
  handle(ARTIFACT_HOST_CHANNELS.open, async (event, value: unknown) => {
    let input: ArtifactHostOpenInput;
    try {
      input = artifactHostOpenInput(value, trustedRendererUrl);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Invalid artifact host details",
      };
    }
    let controller: ArtifactHostController | null;
    try {
      controller = getController(event);
    } catch {
      controller = null;
    }
    if (!controller) {
      return { ok: false, error: "Interactive artifacts are unavailable in this desktop build" };
    }
    return controller.open(input);
  });
  handle(ARTIFACT_HOST_CHANNELS.setBounds, (event, hostId: unknown, bounds: unknown) => {
    const id = artifactHostId(hostId);
    const validBounds = artifactHostBounds(bounds);
    getController(event)?.setBounds(id, validBounds);
  });
  handle(ARTIFACT_HOST_CHANNELS.setVisible, (event, hostId: unknown, visible: unknown) => {
    const id = artifactHostId(hostId);
    const validVisible = artifactHostVisible(visible);
    getController(event)?.setVisible(id, validVisible);
  });
  handle(ARTIFACT_HOST_CHANNELS.postTheme, (event, hostId: unknown, theme: unknown) => {
    const id = artifactHostId(hostId);
    const validTheme = artifactThemeMessage(theme);
    getController(event)?.postTheme(id, validTheme);
  });
  handle(ARTIFACT_HOST_CHANNELS.close, (event, hostId: unknown) => {
    getController(event)?.close(artifactHostId(hostId));
  });
}
