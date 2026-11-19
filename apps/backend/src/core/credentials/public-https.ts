import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

const specialIPv4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  specialIPv4.addSubnet(address, prefix);
}

const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");
const specialIPv6 = new BlockList();
specialIPv6.addSubnet("2001::", 23, "ipv6");
specialIPv6.addSubnet("2001:db8::", 32, "ipv6");
specialIPv6.addSubnet("2002::", 16, "ipv6");
specialIPv6.addSubnet("3fff::", 20, "ipv6");

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !specialIPv4.check(address);
  return (
    family === 6 &&
    !address.includes("%") &&
    globalIPv6.check(address, "ipv6") &&
    !specialIPv6.check(address, "ipv6")
  );
}

/** Refuse the whole DNS answer if any destination is outside the public boundary. */
export async function resolvePublicAddress(
  hostname: string,
  resolve: (hostname: string) => Promise<readonly { address: string }[]> = (host) =>
    lookup(host, { all: true }),
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answers = await Promise.race([
      resolve(hostname),
      new Promise<null>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(null), 5_000);
      }),
    ]);
    if (
      !answers?.length ||
      answers.length > 64 ||
      answers.some(({ address }) => !isPublicAddress(address))
    )
      return null;
    return answers[0]!.address;
  } finally {
    clearTimeout(timer);
  }
}

/** Test transport seam. Production uses the pinned TLS connection below. */
export type CredentialFetch = (url: URL, init: RequestInit) => Promise<Response>;

export interface CredentialHttpResponse {
  status: number;
  statusText: string;
  headers: Pick<Headers, "get">;
  body: AsyncIterable<Uint8Array> | null;
}

/** Dial the validated literal while keeping the approved hostname for TLS and HTTP. */
export function sendPinnedHttps(
  url: URL,
  address: string,
  options: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
): Promise<CredentialHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: address,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: options.method,
        headers: { ...options.headers, host: url.host, "accept-encoding": "identity" },
        servername: url.hostname,
        checkServerIdentity: (_hostname, cert) => checkServerIdentity(url.hostname, cert),
        rejectUnauthorized: true,
        agent: false,
        signal: options.signal,
        maxHeaderSize: 16_384,
      },
      (response) => {
        const headers = response.headers;
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? "",
          headers: {
            get: (name) => {
              const value = headers[name];
              return Array.isArray(value) ? value.join(", ") : (value ?? null);
            },
          },
          body: response,
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}
