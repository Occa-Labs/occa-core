"use client";

// Connection section of the tool detail panel — shows the tool's stored
// credentials (endpoint URL, secret, etc.) to the company owner. Non-secret
// fields render in full; secret fields are masked (last 4 shown) with a reveal
// toggle and copy. Values come from the owner-only credentials endpoint; the
// field labels + secret flags come from the catalog the parent already holds.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import type { ToolCredentialField } from "@occa/shared/types";
import { toolsApi } from "@/lib/api";

export function ToolConnection({
  companyId,
  toolId,
  fields,
}: {
  companyId: string;
  toolId: string;
  fields: ToolCredentialField[];
}) {
  const query = useQuery({
    queryKey: ["tools", "credentials", companyId, toolId],
    queryFn: () => toolsApi.credentials(companyId, toolId),
  });
  const values = query.data?.values ?? {};

  if (fields.length === 0) return null;

  return (
    <div className="space-y-2">
      {fields.map((f) => (
        <CredentialRow
          key={f.name}
          field={f}
          value={values[f.name] ?? ""}
          loading={query.isLoading}
        />
      ))}
    </div>
  );
}

function CredentialRow({
  field,
  value,
  loading,
}: {
  field: ToolCredentialField;
  value: string;
  loading: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const shown = loading
    ? "…"
    : !value
      ? "—"
      : field.secret && !revealed
        ? maskSecret(value)
        : value;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  return (
    <div className="rounded-md bg-white/4 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-white/40 font-mono">
          {field.name}
          {field.secret && (
            <span className="ml-1.5 text-amber-300/50 normal-case">secret</span>
          )}
        </span>
        {value && (
          <div className="flex items-center gap-0.5">
            {field.secret && (
              <button
                type="button"
                onClick={() => setRevealed((v) => !v)}
                title={revealed ? "Hide" : "Reveal"}
                className="cursor-pointer p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/8"
              >
                {revealed ? (
                  <EyeOff className="size-3" />
                ) : (
                  <Eye className="size-3" />
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => void copy()}
              title="Copy"
              className="cursor-pointer p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/8"
            >
              {copied ? (
                <Check className="size-3 text-emerald-300" />
              ) : (
                <Copy className="size-3" />
              )}
            </button>
          </div>
        )}
      </div>
      <p className="text-[12px] text-white/85 font-mono break-all mt-0.5">
        {shown}
      </p>
      {field.description && (
        <p className="text-[10px] text-white/35 mt-1 leading-relaxed">
          {field.description}
        </p>
      )}
    </div>
  );
}

// Mask all but the last 4 characters so the owner can sanity-check which
// secret is stored without exposing it. Short values fully masked.
function maskSecret(value: string): string {
  if (value.length <= 4) return "••••";
  return "•".repeat(Math.min(value.length - 4, 24)) + value.slice(-4);
}
