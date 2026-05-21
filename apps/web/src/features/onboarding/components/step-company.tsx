"use client";

// Onboarding step 1 — capture the company name. No API call yet; the
// row is only committed in the final step, atomically with the CEO
// agent (mirrors the archived single-shot launch flow). Lifting state
// to the parent lets a returning user resume past this step with a
// pre-filled value drawn from the server.

import { ArrowRight, Building2 } from "lucide-react";

interface StepCompanyProps {
  value: string;
  onChange: (next: string) => void;
  onContinue: () => void;
}

export function StepCompany({ value, onChange, onContinue }: StepCompanyProps) {
  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onContinue();
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <div className="flex items-start gap-2.5">
        <Building2 className="size-4 shrink-0 text-white/45 mt-0.5" />
        <div>
          <h2 className="text-[13px] font-semibold text-white/90">
            Name your company
          </h2>
          <p className="mt-1 text-[11px] text-white/45 leading-relaxed">
            This is what your agents will call you. The company row gets
            created when you finish the wizard — you can rename it later
            from the Company window.
          </p>
        </div>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-white/40">
          Company name
        </span>
        <input
          type="text"
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Acme Studio"
          maxLength={64}
          className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-white/25 focus:outline-none"
        />
      </label>

      <div className="flex justify-end pt-1">
        <button
          type="submit"
          disabled={!canSubmit}
          className="flex cursor-pointer items-center gap-1.5 rounded-md bg-sky-500/20 px-3 py-1.5 text-[12px] font-medium text-sky-100 transition-colors hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowRight className="size-3.5" />
          Continue
        </button>
      </div>
    </form>
  );
}
