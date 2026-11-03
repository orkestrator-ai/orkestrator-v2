// What the application sees of the request, so a preview spec can check the
// authority and forwarded headers the preview presents upstream.
export const dynamic = "force-dynamic";

export function GET(request) {
  const headers = request.headers;
  return Response.json({
    host: headers.get("host"),
    forwardedHost: headers.get("x-forwarded-host"),
    forwardedProto: headers.get("x-forwarded-proto"),
    url: request.url,
  });
}
