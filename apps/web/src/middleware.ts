import { NextResponse, type NextRequest } from "next/server";

// Production demo lockdown. Production builds redirect every non-/demo
// route to /demo by default — the real app stays gated until launch.
// Override:
//   NEXT_PUBLIC_DEMO_MODE=1 → force lockdown (also works in dev)
//   NEXT_PUBLIC_DEMO_MODE=0 → opt out in production (debugging only)

const isDemoMode = () => {
  const flag = process.env.NEXT_PUBLIC_DEMO_MODE;
  if (flag === "1") return true;
  if (flag === "0") return false;
  return process.env.NODE_ENV === "production";
};

export function middleware(request: NextRequest) {
  if (!isDemoMode()) return NextResponse.next();
  if (request.nextUrl.pathname === "/demo") return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/demo";
  return NextResponse.redirect(url);
}

// Skip API routes, Next.js internals, and static files.
export const config = {
  matcher: "/((?!api|_next|.*\\..*).*)",
};
