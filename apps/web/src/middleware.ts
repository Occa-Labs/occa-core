import { NextResponse, type NextRequest } from "next/server";

// Production demo lockdown. Production builds redirect every non-/demo
// route to /demo by default — the real app stays gated until launch.
// Override:
//   NEXT_PUBLIC_DEMO_MODE=1 → force lockdown (also works in dev)
//   NEXT_PUBLIC_DEMO_MODE=0 → opt out in production (debugging only)

const isDemoMode = () => {
  // The demo lockdown is a pure 3D-office showcase. When the office is not
  // enabled (the open-source mirror without the licensed assets) there is
  // no demo to redirect to, so force the lockdown off — otherwise every
  // route would land on a /demo that can't load.
  if (process.env.NEXT_PUBLIC_ENABLE_3D_OFFICE !== "1") return false;
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
