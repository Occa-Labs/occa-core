"use client";

import { useState } from "react";
import { Loader2, RotateCcw, AlertTriangle } from "lucide-react";
import { devApi, ApiError } from "@/lib/api";

/**
 * Dev-only quick-reset escape hatch. Nukes:
 *   1. Gateway agents (via /api/dev/reset-gateway, SSH-side cleanup)
 *   2. Database (via /api/dev/reset — drops companies + nonces, keeps user)
 * Then hard-reloads so the client state machines reboot cleanly.
 *
 * Mounted only when NODE_ENV === 'development' and the user is authed.
 */
export function DevResetButton() {
  const [step, setStep] = useState<"idle" | "confirm">("idle");
  const [busy, setBusy] = useState<null | "gateway" | "db">(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string[]>([]);

  const run = async () => {
    setError(null);
    setProgress([]);
    try {
      setBusy("gateway");
      setProgress((p) => [...p, "Cleaning gateway agents…"]);
      try {
        await devApi.resetGateway();
        setProgress((p) => [...p, "Gateway clean ✓"]);
      } catch (err) {
        const msg = err instanceof ApiError ? `api_${err.status}` : "skipped";
        setProgress((p) => [...p, `Gateway: ${msg} (continuing)`]);
      }
      setBusy("db");
      setProgress((p) => [...p, "Nuking database…"]);
      await devApi.reset();
      setProgress((p) => [...p, "DB clean ✓ — reloading…"]);
      // Clear stored JWT so wallet-connect overlay re-engages cleanly.
      window.localStorage.removeItem("occa_jwt");
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `api_${err.status}`
          : err instanceof Error
            ? err.message
            : "reset_failed";
      setError(msg);
      setBusy(null);
    }
  };

  if (step === "idle") {
    return (
      <button
        type="button"
        onClick={() => setStep("confirm")}
        title="Dev: reset gateway + database"
        style={{
          position: "fixed",
          bottom: 12,
          right: 12,
          zIndex: 9999,
          background: "rgba(0,0,0,0.5)",
          color: "rgba(255,255,255,0.7)",
          padding: "6px 10px",
          borderRadius: 8,
          fontSize: 11,
          fontFamily: "monospace",
          border: "1px solid rgba(255,255,255,0.12)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <RotateCcw size={11} />
        dev reset
      </button>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        bottom: 12,
        right: 12,
        zIndex: 9999,
        background: "rgba(20, 20, 24, 0.95)",
        color: "white",
        padding: 12,
        borderRadius: 10,
        fontSize: 11,
        fontFamily: "monospace",
        border: "1px solid rgba(220, 38, 38, 0.45)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        minWidth: 280,
        maxWidth: 360,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 8,
        }}
      >
        <AlertTriangle size={12} style={{ color: "#fbbf24" }} />
        <strong>Reset gateway + database</strong>
      </div>
      <p style={{ color: "rgba(255,255,255,0.6)", marginBottom: 10 }}>
        Drops all OpenClaw agents prefixed <code>occa-</code> on the gateway,
        then deletes companies + nonces from DB. You will need to re-onboard.
      </p>
      {progress.length > 0 && (
        <div
          style={{
            background: "rgba(255,255,255,0.05)",
            borderRadius: 6,
            padding: 8,
            marginBottom: 8,
            color: "rgba(255,255,255,0.8)",
            fontSize: 10,
            lineHeight: 1.6,
          }}
        >
          {progress.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      {error && (
        <div
          style={{
            color: "#fca5a5",
            background: "rgba(239,68,68,0.1)",
            padding: 6,
            borderRadius: 6,
            marginBottom: 8,
          }}
        >
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        {busy === null && (
          <>
            <button
              type="button"
              onClick={() => {
                setStep("idle");
                setError(null);
                setProgress([]);
              }}
              style={{
                background: "transparent",
                color: "rgba(255,255,255,0.6)",
                border: "1px solid rgba(255,255,255,0.15)",
                padding: "5px 10px",
                borderRadius: 6,
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void run()}
              style={{
                background: "#dc2626",
                color: "white",
                border: "none",
                padding: "5px 12px",
                borderRadius: 6,
                fontSize: 11,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              Yes, nuke it
            </button>
          </>
        )}
        {busy !== null && (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "rgba(255,255,255,0.7)",
            }}
          >
            <Loader2 size={11} className="animate-spin" />
            {busy === "gateway" ? "Resetting gateway…" : "Resetting DB…"}
          </span>
        )}
      </div>
    </div>
  );
}
