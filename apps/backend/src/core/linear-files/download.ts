/**
 * Downloads one file from Linear's file host with the workspace's key. The key
 * is only ever sent to that host: a redirect elsewhere is followed without it.
 */
import { LINEAR_FILE_HOST, linearFileUrl } from "@orkestrator/protocol/linear-files";

const LINEAR_FILE_ORIGIN = `https://${LINEAR_FILE_HOST}`;
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface DownloadedLinearFile {
  contents: Buffer;
  contentType?: string;
  filename?: string;
}

export class LinearFileSizeLimitError extends Error {
  constructor(maxBytes: number) {
    const limit =
      maxBytes < 1024 * 1024 ? `${maxBytes} bytes` : `${Math.floor(maxBytes / (1024 * 1024))} MB`;
    super(`The file is larger than the ${limit} limit.`);
  }
}

function dispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      // Malformed: use the plain parameter.
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  return (plain?.[1] ?? plain?.[2])?.trim() || undefined;
}

function statusError(status: number): Error {
  if (status === 401 || status === 403) {
    return new Error(
      `Linear refused the download (${status}). The Linear connection on this machine may not have access to it.`,
    );
  }
  if (status === 404) return new Error("Linear no longer has this file (404).");
  return new Error(`Linear answered ${status}.`);
}

async function readBounded(
  response: Response,
  maxBytes: number,
  onBytes?: (bytes: number) => void,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new LinearFileSizeLimitError(maxBytes);
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    onBytes?.(value.byteLength);
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new LinearFileSizeLimitError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytes);
}

async function openLinearFileResponse(
  fileUrl: string,
  options: { apiKey?: string; signal?: AbortSignal; probe?: boolean },
): Promise<Response> {
  const canonical = linearFileUrl(fileUrl);
  if (!canonical) throw new Error("Not a file on Linear's file host.");
  let url = new URL(options.probe ? fileUrl : canonical);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: options.signal,
        headers: {
          ...(options.apiKey && url.origin === LINEAR_FILE_ORIGIN
            ? { Authorization: options.apiKey.trim() }
            : {}),
          ...(options.probe ? { Range: "bytes=0-0" } : {}),
        },
      });
    } catch {
      throw new Error(
        options.signal?.aborted ? "The download timed out." : "Linear's file host is unreachable.",
      );
    }
    if (REDIRECTS.has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      const next = location ? URL.parse(location, url.href) : null;
      if (next?.protocol !== "https:") throw new Error("Linear redirected to an unusable address.");
      url = next;
      continue;
    }
    if (
      options.probe &&
      response.status === 416 &&
      response.headers.get("content-range") === "bytes */0"
    )
      return response;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw statusError(response.status);
    }
    return response;
  }
  throw new Error("Linear redirected too many times.");
}

/** Tests the signed URL the browser will open without downloading the body. */
export async function checkSignedLinearFile(signedUrl: string, signal: AbortSignal): Promise<void> {
  const response = await openLinearFileResponse(signedUrl, { probe: true, signal });
  await response.body?.cancel().catch(() => undefined);
}

/** Errors are safe to show: they never hold the key or a redirect's signed address. */
export async function downloadLinearFile(
  apiKey: string,
  fileUrl: string,
  options: { maxBytes: number; signal?: AbortSignal; onBytes?: (bytes: number) => void },
): Promise<DownloadedLinearFile> {
  const response = await openLinearFileResponse(fileUrl, { apiKey, signal: options.signal });
  const contentType = response.headers.get("content-type") ?? undefined;
  const filename = dispositionFilename(response.headers.get("content-disposition"));
  let contents: Buffer;
  try {
    contents = await readBounded(response, options.maxBytes, options.onBytes);
  } catch (error) {
    if (options.signal?.aborted) throw new Error("The download timed out.");
    throw error;
  }
  return {
    contents,
    ...(contentType ? { contentType } : {}),
    ...(filename ? { filename } : {}),
  };
}
