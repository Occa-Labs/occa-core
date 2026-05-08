"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Monitor } from "lucide-react";

// Width threshold matches Tailwind's `lg`. Below this, the windowed-app
// chrome (Agents, Skills, Tasks…) wraps awkwardly and the 3D office
// camera framing assumes desktop aspect ratios. The pointer check
// excludes pure touch devices (phones, tablets in any orientation) even
// when their viewport is wide enough — `any-pointer: fine` returns true
// for hybrid laptops with both touch + trackpad, so those pass through.
const MIN_WIDTH = 1024;

type Mode = "loading" | "desktop" | "mobile";

function detect(): Mode {
  if (typeof window === "undefined") return "loading";
  const wide = window.innerWidth >= MIN_WIDTH;
  const fine = window.matchMedia("(any-pointer: fine)").matches;
  return wide && fine ? "desktop" : "mobile";
}

export function DesktopOnlyGate({ children }: { children: ReactNode }) {
  // Initial state is "loading" so the SSR HTML matches the first client
  // render — no hydration mismatch. The effect runs immediately after
  // mount and resolves to "desktop" or "mobile" before paint settles.
  const [mode, setMode] = useState<Mode>("loading");

  useEffect(() => {
    const update = () => setMode(detect());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  if (mode === "loading") {
    return (
      <main
        className="fixed inset-0 h-screen w-screen"
        style={{ background: "var(--app-bg-scene)" }}
      />
    );
  }

  if (mode === "mobile") {
    return <DesktopOnlyMessage />;
  }

  return <>{children}</>;
}

function DesktopOnlyMessage() {
  return (
    <main
      className="fixed inset-0 h-screen w-screen flex items-center justify-center px-6"
      style={{ background: "var(--app-bg-scene)" }}
    >
      <div className="max-w-md w-full text-center space-y-5 rounded-3xl px-8 py-10">
        <div className="size-12 mx-auto rounded-2xl flex items-center justify-center"
          style={{
            background: "rgba(255,255,255,0.08)",
          }}
        >
          <Monitor className="size-6 text-white/85" />
        </div>
        <div className="space-y-2">
          <h1 className="text-[18px] font-semibold text-white/90 tracking-tight">
            Desktop only, for now
          </h1>
          <p className="text-[13px] text-white/60 leading-relaxed">
            OCCA OS is a 3D office workspace built for wider screens with a
            mouse or trackpad. Open this on a desktop or laptop to enter
            your office.
          </p>
        </div>
      </div>
    </main>
  );
}
