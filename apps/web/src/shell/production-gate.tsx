"use client";

import dynamic from "next/dynamic";
import { Sparkles } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

// R3F scene — browser-only. Three.js needs a real DOM/canvas, so SSR
// is impossible.
const OfficeScene = dynamic(
  () =>
    import("@/features/theater/components/office-scene").then(
      (m) => m.OfficeScene,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex h-full w-full items-center justify-center"
        style={{ background: "var(--app-bg-loading)" }}
      >
        <Spinner className="size-8 text-white" />
      </div>
    ),
  },
);

// Standalone production preview screen — an empty 3D office backdrop
// with a "not ready" notice on top. Mounted by layout.tsx whenever
// IS_PRODUCTION_MODE is true; no app providers (wallet, auth, query)
// are spun up beneath it.
export function ProductionGate() {
  return (
    <main
      className="fixed inset-0 h-screen w-screen overflow-hidden"
      style={{ background: "var(--app-bg-scene)" }}
    >
      <OfficeScene />
      <ProductionNotReadyOverlay />
    </main>
  );
}

function ProductionNotReadyOverlay() {
  return (
    <div
      // z-100 keeps the overlay above the canvas without colliding
      // with the in-app window stack (which tops out around z-50).
      className="fixed inset-0 z-100 flex items-center justify-center px-6"
      style={{
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }}
    >
      <div
        className="max-w-md w-full text-center space-y-6 rounded-3xl px-8 py-10"
        style={{
          background: "rgba(20,20,22,0.72)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          border: "1px solid rgba(255,255,255,0.10)",
          boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
        }}
      >
        <div
          className="size-12 mx-auto rounded-2xl flex items-center justify-center"
          style={{ background: "rgba(255,255,255,0.08)" }}
        >
          <Sparkles className="size-6 text-white/85" />
        </div>
        <div className="space-y-2">
          <h1 className="text-[20px] font-semibold text-white/90 tracking-tight">
            Production not ready yet
          </h1>
          <p className="text-[13px] text-white/60 leading-relaxed">
            OCCA OS is still in active development. The hosted instance is not
            open for general use.
          </p>
        </div>
      </div>
    </div>
  );
}
