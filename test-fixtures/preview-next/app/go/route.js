import { NextResponse } from "next/server";

// An absolute redirect built from the request URL, the way applications
// commonly write them; the preview maps its private origin back to the public one.
export const dynamic = "force-dynamic";

export function GET(request) {
  return NextResponse.redirect(new URL("/items/7", request.url));
}
