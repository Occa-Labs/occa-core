"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SpeakerBadge } from "@/components/ui/speaker-badge";
import {
  kickoffApi,
  type KickoffRoleEntry,
  type KickoffRoleCategory,
} from "@/lib/api";

interface KickoffDialogProps {
  companyId: string;
  ceoName: string;
  /** Fires once the kickoff start request lands successfully (202). The
   *  parent transitions into the progress-banner phase from there. */
  onStarted: () => void;
}

type StepKey =
  | "intro"
  | "description"
  | "niche"
  | "audience"
  | "voice"
  | "team"
  | "confirm";

const CATEGORY_ORDER: KickoffRoleCategory[] = [
  "c_suite",
  "leadership",
  "engineering",
  "product_design",
  "marketing_growth",
  "editorial_content",
  "operations_admin",
  "sales_success",
  "data_research",
  "web3",
];

const CATEGORY_LABEL: Record<KickoffRoleCategory, string> = {
  c_suite: "C-Suite",
  leadership: "Heads / VPs",
  engineering: "Engineering",
  product_design: "Product / Design",
  marketing_growth: "Marketing / Growth",
  editorial_content: "Editorial / Content",
  operations_admin: "Operations / Admin",
  sales_success: "Sales / Success",
  data_research: "Data / Research",
  web3: "Web3 Specialty",
};

const NICHE_OPTIONS = [
  { id: "ai_crypto", label: "AI × Crypto" },
  { id: "depin", label: "DePIN + infrastructure" },
  { id: "defi", label: "DeFi + on-chain markets" },
  { id: "memecoin", label: "Memecoin + attention" },
  { id: "custom", label: "Custom — let me describe" },
] as const;

const VOICE_OPTIONS = [
  { id: "calm", label: "Calm, framework-driven, dry humor" },
  { id: "punchy", label: "Punchy, contrarian, opinionated" },
  { id: "educational", label: "Educational, accessible, clear" },
  { id: "custom", label: "Custom — let me describe" },
] as const;

const TYPING_SPEED = 30;

// ── Component ───────────────────────────────────────────────────────────────

export function KickoffDialog({
  companyId,
  ceoName,
  onStarted,
}: KickoffDialogProps) {
  const [step, setStep] = useState<StepKey>("intro");
  const [description, setDescription] = useState("");
  const [nicheChoice, setNicheChoice] = useState<string | null>(null);
  const [nicheCustom, setNicheCustom] = useState("");
  const [audience, setAudience] = useState("");
  const [voiceChoice, setVoiceChoice] = useState<string | null>(null);
  const [voiceCustom, setVoiceCustom] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Role catalog — TanStack Query handles dedup, cache (5min stale), retry,
  // and fetches lazily once the team step is reached. Inspect via
  // ReactQueryDevtools panel (bottom-left in dev).
  const rolesQuery = useQuery({
    queryKey: ["kickoff", "roles"] as const,
    queryFn: kickoffApi.listRoles,
    staleTime: 5 * 60 * 1000,
    enabled: step === "team",
  });
  const availableRoles: KickoffRoleEntry[] = rolesQuery.data?.roles ?? [];
  const maxHires = rolesQuery.data?.maxHires ?? 5;
  const rolesLoading = rolesQuery.isPending;

  // Surface fetch error onto the dialog's existing error state.
  useEffect(() => {
    if (rolesQuery.isError && !error) {
      setError(
        rolesQuery.error instanceof Error
          ? rolesQuery.error.message
          : "load_roles_failed",
      );
    }
  }, [rolesQuery.isError, rolesQuery.error, error]);

  const toggleRole = (key: string) => {
    setSelectedRoles((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= maxHires) return prev;
      return [...prev, key];
    });
  };

  const stepText = STEP_PROMPTS[step](ceoName);
  const [displayedText, setDisplayedText] = useState("");
  const [isTyping, setIsTyping] = useState(true);
  const skipRef = useRef(false);

  useEffect(() => {
    setDisplayedText("");
    setIsTyping(true);
    skipRef.current = false;
    let i = 0;
    const id = setInterval(() => {
      if (skipRef.current) {
        setDisplayedText(stepText);
        setIsTyping(false);
        clearInterval(id);
        return;
      }
      i++;
      setDisplayedText(stepText.slice(0, i));
      if (i >= stepText.length) {
        setIsTyping(false);
        clearInterval(id);
      }
    }, TYPING_SPEED);
    return () => clearInterval(id);
  }, [stepText]);

  const advance = () => {
    if (isTyping) {
      skipRef.current = true;
      return;
    }
    const order: StepKey[] = [
      "intro",
      "description",
      "niche",
      "audience",
      "voice",
      "team",
      "confirm",
    ];
    const next = order[order.indexOf(step) + 1];
    if (next) setStep(next);
  };

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await kickoffApi.start(companyId, {
        description: description.trim() || null,
        niche:
          nicheChoice === "custom"
            ? nicheCustom.trim() || null
            : (NICHE_OPTIONS.find((o) => o.id === nicheChoice)?.label ?? null),
        audience: audience.trim() || null,
        brandVoice:
          voiceChoice === "custom"
            ? voiceCustom.trim() || null
            : (VOICE_OPTIONS.find((o) => o.id === voiceChoice)?.label ?? null),
        contentPillars: [],
        roles: selectedRoles,
      });
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "kickoff_failed");
      setSubmitting(false);
    }
  };

  // ── Per-step body ────────────────────────────────────────────────────────

  const body = (() => {
    if (isTyping) return null;
    switch (step) {
      case "intro":
        return (
          <Continue label="Tell me more" onClick={advance} />
        );
      case "description":
        return (
          <>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="In one or two sentences, what does the company do?"
              className={textareaCls}
              rows={3}
              autoFocus
            />
            <Continue
              label="Continue"
              onClick={advance}
              disabled={description.trim().length === 0}
            />
          </>
        );
      case "niche":
        return (
          <>
            <Choices
              options={NICHE_OPTIONS.map((o) => ({ id: o.id, label: o.label }))}
              selected={nicheChoice}
              onSelect={setNicheChoice}
            />
            {nicheChoice === "custom" && (
              <input
                value={nicheCustom}
                onChange={(e) => setNicheCustom(e.target.value)}
                placeholder="Describe the niche…"
                className={inputCls}
              />
            )}
            <Continue
              label="Continue"
              onClick={advance}
              disabled={
                !nicheChoice ||
                (nicheChoice === "custom" && nicheCustom.trim().length === 0)
              }
            />
          </>
        );
      case "audience":
        return (
          <>
            <textarea
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="Web3 founders, crypto investors, builders…"
              className={textareaCls}
              rows={2}
              autoFocus
            />
            <Continue
              label="Continue"
              onClick={advance}
              disabled={audience.trim().length === 0}
            />
          </>
        );
      case "voice":
        return (
          <>
            <Choices
              options={VOICE_OPTIONS.map((o) => ({ id: o.id, label: o.label }))}
              selected={voiceChoice}
              onSelect={setVoiceChoice}
            />
            {voiceChoice === "custom" && (
              <input
                value={voiceCustom}
                onChange={(e) => setVoiceCustom(e.target.value)}
                placeholder="Describe the brand voice…"
                className={inputCls}
              />
            )}
            <Continue
              label="Continue"
              onClick={advance}
              disabled={
                !voiceChoice ||
                (voiceChoice === "custom" && voiceCustom.trim().length === 0)
              }
            />
          </>
        );
      case "team":
        return (
          <RolePicker
            roles={availableRoles}
            loading={rolesLoading}
            selected={selectedRoles}
            maxHires={maxHires}
            onToggle={toggleRole}
            onContinue={advance}
          />
        );
      case "confirm":
        return (
          <>
            {error && (
              <div className="text-[11px] text-red-300/85 bg-red-500/10 rounded-md px-2 py-1.5">
                Failed: {error}
              </div>
            )}
            <Continue
              label={submitting ? "Setting up…" : "Start hiring"}
              onClick={submit}
              disabled={submitting}
            />
          </>
        );
    }
  })();

  return (
    <div className="fixed inset-0 z-100 flex items-end justify-center pointer-events-none">
      <div className="relative w-full max-w-2xl mx-4 mb-8 pointer-events-auto">
        <Card spotlight padding="lg" className="relative">
          <div className="absolute top-0 left-6 -translate-y-1/2 z-10">
            <SpeakerBadge name={ceoName} kind="agent" />
          </div>

          <div className="mt-2 min-h-12 flex items-start">
            <p className="text-sm text-white/90 leading-relaxed">
              {displayedText}
              {isTyping && (
                <span className="inline-block w-0.5 h-4 bg-white/60 ml-0.5 align-middle" />
              )}
            </p>
          </div>

          {body && <div className="mt-4 flex flex-col gap-3">{body}</div>}

          <div className="mt-4 flex items-center justify-center gap-1.5">
            {(
              [
                "intro",
                "description",
                "niche",
                "audience",
                "voice",
                "team",
                "confirm",
              ] as StepKey[]
            ).map((s, i) => {
              const order: StepKey[] = [
                "intro",
                "description",
                "niche",
                "audience",
                "voice",
                "team",
                "confirm",
              ];
              const currentIdx = order.indexOf(step);
              return (
                <div
                  key={s}
                  className="h-1 rounded-full transition-all duration-300"
                  style={{
                    width: i === currentIdx ? 16 : 6,
                    backgroundColor:
                      i === currentIdx
                        ? "rgba(255,255,255,0.6)"
                        : i < currentIdx
                          ? "rgba(255,255,255,0.3)"
                          : "rgba(255,255,255,0.1)",
                  }}
                />
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Step prompt copy ─────────────────────────────────────────────────────────

const STEP_PROMPTS: Record<StepKey, (ceoName: string) => string> = {
  intro: (ceoName) =>
    `Glad to finally meet you. Before I start moving on the company, I need a few things from you.`,
  description: () => "What are we building? Just one or two sentences.",
  niche: () => "Got it. What space are we operating in?",
  audience: () => "Who are we serving?",
  voice: () => "How should we sound? Editorial voice across everything we ship.",
  team: () =>
    "Last thing — how aggressive should we hire? You can grow the team later.",
  confirm: () =>
    "OK, I'll set up the team. Provisioning takes about a minute, then we'll do a kickoff meeting together.",
};

// ── Reusable bits ────────────────────────────────────────────────────────────

const inputCls =
  "w-full rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25 transition-colors";

const textareaCls = `${inputCls} resize-y leading-relaxed`;

function Continue({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex justify-end">
      <Button variant="primary" size="sm" onClick={onClick} disabled={disabled}>
        {label}
      </Button>
    </div>
  );
}

function Choices({
  options,
  selected,
  onSelect,
}: {
  options: ReadonlyArray<{ id: string; label: string }>;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onSelect(o.id)}
          className={`
            w-full text-left rounded-xl border px-3 py-2 text-[12px]
            transition-colors
            ${
              selected === o.id
                ? "bg-blue-400/15 border-blue-400/40 text-white"
                : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10"
            }
          `}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function RolePicker({
  roles,
  loading,
  selected,
  maxHires,
  onToggle,
  onContinue,
}: {
  roles: KickoffRoleEntry[];
  loading: boolean;
  selected: string[];
  maxHires: number;
  onToggle: (key: string) => void;
  onContinue: () => void;
}) {
  // Group by category, ordered. Categories with no entries get skipped.
  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    items: roles.filter((r) => r.category === cat),
  })).filter((g) => g.items.length > 0);

  const atCap = selected.length >= maxHires;

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-white/55">
          Pick up to {maxHires}. They report to you; you can hire ICs later.
        </span>
        <span
          className={`text-[11px] font-semibold ${
            atCap ? "text-amber-300/90" : "text-white/65"
          }`}
        >
          {selected.length}/{maxHires}
        </span>
      </div>

      <div className="max-h-72 overflow-y-auto pr-1 flex flex-col gap-3">
        {loading && roles.length === 0 ? (
          <div className="text-[12px] text-white/45 py-4 text-center">
            Loading roles…
          </div>
        ) : (
          grouped.map((g) => (
            <div key={g.category} className="flex flex-col gap-1.5">
              <div className="text-[10px] uppercase tracking-wide text-white/35">
                {CATEGORY_LABEL[g.category]}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {g.items.map((r) => {
                  const isSelected = selected.includes(r.key);
                  const disabled = !isSelected && atCap;
                  return (
                    <button
                      key={r.key}
                      type="button"
                      onClick={() => onToggle(r.key)}
                      disabled={disabled}
                      title={r.description}
                      className={`
                        rounded-full border px-2.5 py-1 text-[11px]
                        transition-colors
                        ${
                          isSelected
                            ? "bg-blue-400/20 border-blue-400/50 text-white"
                            : disabled
                              ? "bg-white/3 border-white/8 text-white/30 cursor-not-allowed"
                              : "bg-white/5 border-white/10 text-white/75 hover:bg-white/10"
                        }
                      `}
                    >
                      {r.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      <Continue
        label={
          selected.length === 0
            ? "Pick at least one"
            : `Continue with ${selected.length}`
        }
        onClick={onContinue}
        disabled={selected.length === 0}
      />
    </>
  );
}
