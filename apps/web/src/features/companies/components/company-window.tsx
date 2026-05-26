"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Building2,
  Globe,
  Mail,
  Mic,
  Pause,
  Pencil,
  Play,
  PlayCircle,
  Save,
  Sparkles,
  Target,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { AppWindow } from "@/components/ui/app-window";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useCompany } from "@/features/companies/api/use-company";
import type {
  CompanyDTO,
  UpdateCompanyRequest,
} from "@occa/shared/types";

interface CompanyWindowProps {
  companyId: string;
  onClose?: () => void;
  /** Open the kickoff meeting transcript in replay mode. Surfaced when
   *  kickoffState is 'completed'. Os shell hosts the meeting window. */
  onOpenMeetingReplay?: () => void;
}

// ── Sidebar sections ─────────────────────────────────────────────────────────

type SectionId =
  | "identity"
  | "voice"
  | "mission"
  | "output"
  | "contact"
  | "presence"
  | "crypto"
  | "overview";

const SECTIONS: Array<{
  id: SectionId;
  label: string;
  icon: LucideIcon;
  hint: string;
}> = [
  { id: "identity", label: "Identity", icon: Building2, hint: "Name, tagline, niche" },
  { id: "voice", label: "Voice", icon: Mic, hint: "Editorial coverage + tone" },
  { id: "mission", label: "Mission", icon: Target, hint: "Mission, vision, audience" },
  { id: "output", label: "Output", icon: Sparkles, hint: "Offering + services" },
  { id: "contact", label: "Contact", icon: Mail, hint: "Emails, phone" },
  { id: "presence", label: "Presence", icon: Globe, hint: "Web + social handles" },
  { id: "crypto", label: "Crypto-native", icon: Wallet, hint: "Treasury, chains" },
  { id: "overview", label: "Overview", icon: BarChart3, hint: "Stats + state" },
];

const KNOWN_SOCIAL_PLATFORMS = [
  { key: "twitter", label: "Twitter / X", placeholder: "@handle" },
  { key: "linkedin", label: "LinkedIn", placeholder: "company/your-co" },
  { key: "discord", label: "Discord", placeholder: "invite link" },
  { key: "telegram", label: "Telegram", placeholder: "@channel" },
  { key: "github", label: "GitHub", placeholder: "your-org" },
  { key: "mirror", label: "Mirror", placeholder: "subdomain.mirror.xyz" },
  { key: "youtube", label: "YouTube", placeholder: "@handle" },
  { key: "farcaster", label: "Farcaster", placeholder: "@handle" },
] as const;

// Local working copy of the company. Strings use "" rather than null so
// inputs stay controlled; we convert "" → null on save.
interface FormState {
  name: string;
  tagline: string;
  logoUrl: string;
  niche: string;
  foundedAt: string;
  coverageScope: string;
  coverageExcluded: string;
  contentPillars: string[];
  brandVoice: string;
  forbiddenWords: string[];
  mission: string;
  vision: string;
  targetAudience: string;
  usps: string[];
  coreOffering: string;
  serviceCatalog: string[];
  contactEmail: string;
  salesEmail: string;
  phone: string;
  websiteUrl: string;
  blogUrl: string;
  newsletterUrl: string;
  docsUrl: string;
  socialHandles: Record<string, string>;
  treasuryAddress: string;
  chainsCovered: string[];
}

function fromDTO(c: CompanyDTO): FormState {
  return {
    name: c.name,
    tagline: c.tagline ?? "",
    logoUrl: c.logoUrl ?? "",
    niche: c.niche ?? "",
    foundedAt: c.foundedAt ? c.foundedAt.slice(0, 10) : "",
    coverageScope: c.coverageScope ?? "",
    coverageExcluded: c.coverageExcluded ?? "",
    contentPillars: c.contentPillars,
    brandVoice: c.brandVoice ?? "",
    forbiddenWords: c.forbiddenWords,
    mission: c.mission ?? "",
    vision: c.vision ?? "",
    targetAudience: c.targetAudience ?? "",
    usps: c.usps,
    coreOffering: c.coreOffering ?? "",
    serviceCatalog: c.serviceCatalog,
    contactEmail: c.contactEmail ?? "",
    salesEmail: c.salesEmail ?? "",
    phone: c.phone ?? "",
    websiteUrl: c.websiteUrl ?? "",
    blogUrl: c.blogUrl ?? "",
    newsletterUrl: c.newsletterUrl ?? "",
    docsUrl: c.docsUrl ?? "",
    socialHandles: { ...c.socialHandles },
    treasuryAddress: c.treasuryAddress ?? "",
    chainsCovered: c.chainsCovered,
  };
}

// Diff form against the original DTO; only return the keys that actually
// changed so the PATCH payload stays small + audit-friendly.
function diffForm(form: FormState, original: CompanyDTO): UpdateCompanyRequest {
  const out: UpdateCompanyRequest = {};
  const text = (k: keyof FormState, dtoVal: string | null) => {
    const next = (form[k] as string).trim();
    const prev = dtoVal ?? "";
    if (next !== prev) {
      (out as Record<string, unknown>)[k] = next === "" ? null : next;
    }
  };
  const arr = (k: keyof FormState, dtoVal: string[]) => {
    const next = form[k] as string[];
    if (
      next.length !== dtoVal.length ||
      next.some((v, i) => v !== dtoVal[i])
    ) {
      (out as Record<string, unknown>)[k] = next;
    }
  };

  if (form.name.trim() !== original.name && form.name.trim() !== "") {
    out.name = form.name.trim();
  }
  text("tagline", original.tagline);
  text("logoUrl", original.logoUrl);
  text("niche", original.niche);
  if ((form.foundedAt || null) !== (original.foundedAt?.slice(0, 10) ?? null)) {
    out.foundedAt = form.foundedAt || null;
  }
  text("coverageScope", original.coverageScope);
  text("coverageExcluded", original.coverageExcluded);
  arr("contentPillars", original.contentPillars);
  text("brandVoice", original.brandVoice);
  arr("forbiddenWords", original.forbiddenWords);
  text("mission", original.mission);
  text("vision", original.vision);
  text("targetAudience", original.targetAudience);
  arr("usps", original.usps);
  text("coreOffering", original.coreOffering);
  arr("serviceCatalog", original.serviceCatalog);
  text("contactEmail", original.contactEmail);
  text("salesEmail", original.salesEmail);
  text("phone", original.phone);
  text("websiteUrl", original.websiteUrl);
  text("blogUrl", original.blogUrl);
  text("newsletterUrl", original.newsletterUrl);
  text("docsUrl", original.docsUrl);
  text("treasuryAddress", original.treasuryAddress);
  arr("chainsCovered", original.chainsCovered);

  const cleanedSocial: Record<string, string> = {};
  for (const [k, v] of Object.entries(form.socialHandles)) {
    const t = (v ?? "").trim();
    if (t) cleanedSocial[k] = t;
  }
  const origSocialKeys = Object.keys(original.socialHandles).sort().join(",");
  const newSocialKeys = Object.keys(cleanedSocial).sort().join(",");
  const sameVals =
    origSocialKeys === newSocialKeys &&
    Object.entries(cleanedSocial).every(
      ([k, v]) => original.socialHandles[k] === v,
    );
  if (!sameVals) out.socialHandles = cleanedSocial;

  return out;
}

// ── Component ────────────────────────────────────────────────────────────────

export function CompanyWindow({
  companyId,
  onClose,
  onOpenMeetingReplay,
}: CompanyWindowProps) {
  const { company, stats, loading, error, refresh, update, pause, resume } =
    useCompany(companyId);
  const [form, setForm] = useState<FormState | null>(null);
  const [active, setActive] = useState<SectionId>("identity");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pauseConfirm, setPauseConfirm] = useState(false);
  const [pauseReason, setPauseReason] = useState("");
  // Per-section edit toggle. null = read-only view across all sections.
  // Switching section while editing auto-discards (effect below).
  const [editingSection, setEditingSection] = useState<SectionId | null>(null);
  const lastLoadedId = useRef<string | null>(null);

  useEffect(() => {
    if (!company) return;
    if (lastLoadedId.current === company.id && form) return;
    lastLoadedId.current = company.id;
    setForm(fromDTO(company));
  }, [company, form]);

  const isPaused = !!company?.pausedAt;
  const isReadOnly = isPaused;
  const isEditing = editingSection === active && !isReadOnly;
  const canEdit = !isReadOnly && active !== "overview";
  const paneEditProps = {
    canEdit,
    editing: isEditing,
    onEdit: () => setEditingSection(active),
  };

  // Auto-discard pending edits when user navigates to a different section.
  useEffect(() => {
    if (editingSection === null) return;
    if (editingSection === active) return;
    if (company) setForm(fromDTO(company));
    setEditingSection(null);
  }, [active, editingSection, company]);

  const dirty = useMemo(() => {
    if (!form || !company) return false;
    return Object.keys(diffForm(form, company)).length > 0;
  }, [form, company]);

  const onSave = async () => {
    if (!form || !company) return;
    const patch = diffForm(form, company);
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await update(patch);
      setEditingSection(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "save_failed");
    } finally {
      setSaving(false);
    }
  };

  const onCancelEdit = () => {
    if (company) setForm(fromDTO(company));
    setEditingSection(null);
    setSaveError(null);
  };

  const onResume = async () => {
    setSaving(true);
    try {
      await resume();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "resume_failed");
    } finally {
      setSaving(false);
    }
  };

  const onConfirmPause = async () => {
    setSaving(true);
    setPauseConfirm(false);
    try {
      await pause(pauseReason || null);
      setPauseReason("");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "pause_failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppWindow
      title="Company"
      subtitle={company?.name ?? "Loading…"}
      onClose={onClose}
      defaultSize={{
        w: Math.min(880, Math.round(window.innerWidth * 0.7)),
        h: Math.min(640, Math.round(window.innerHeight * 0.8)),
      }}
      minWidth={680}
      minHeight={420}
    >
      <div className="flex h-full overflow-hidden">
        <Sidebar active={active} onSelect={setActive} isPaused={isPaused} />

        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-y-auto px-5 py-5">
            {loading && !company && (
              <p className="text-xs text-white/45">Loading company…</p>
            )}
            {error && (
              <Alert variant="error" className="mb-4">
                Failed to load company: {error}.{" "}
                <button
                  onClick={() => void refresh()}
                  className="underline underline-offset-2 hover:text-red-200"
                >
                  Retry
                </button>
              </Alert>
            )}

            {company && form && (
              <>
                {isPaused && active !== "overview" && (
                  <Alert variant="warning" className="mb-4">
                    <p className="font-semibold text-amber-300">
                      Read-only — company is paused
                    </p>
                    <p className="mt-1 text-[11px] text-amber-200/70">
                      Resume from the Overview section to edit.
                    </p>
                  </Alert>
                )}

                {saveError && (
                  <Alert variant="error" className="mb-4">
                    Save failed: {saveError}
                  </Alert>
                )}

                {active === "identity" && (
                  <Pane
                    title="Identity"
                    desc="Public-facing brand basics every agent reads as context."
                    {...paneEditProps}
                  >
                    <Field label="Display name" required>
                      <TextInput
                        value={form.name}
                        onChange={(v) => setForm({ ...form, name: v })}
                        disabled={!isEditing}
                        maxLength={64}
                      />
                    </Field>
                    <Field label="Tagline" hint="One-liner brand pitch">
                      <TextInput
                        value={form.tagline}
                        onChange={(v) => setForm({ ...form, tagline: v })}
                        disabled={!isEditing}
                        maxLength={160}
                      />
                    </Field>
                    <Field label="Niche" hint="Sub-vertical (e.g. AI × Crypto)">
                      <TextInput
                        value={form.niche}
                        onChange={(v) => setForm({ ...form, niche: v })}
                        disabled={!isEditing}
                        maxLength={120}
                      />
                    </Field>
                    <Field label="Logo URL">
                      <TextInput
                        value={form.logoUrl}
                        onChange={(v) => setForm({ ...form, logoUrl: v })}
                        disabled={!isEditing}
                        placeholder="https://..."
                      />
                    </Field>
                    <Field label="Founded">
                      <DateInput
                        value={form.foundedAt}
                        onChange={(v) => setForm({ ...form, foundedAt: v })}
                        disabled={!isEditing}
                      />
                    </Field>
                  </Pane>
                )}

                {active === "voice" && (
                  <Pane
                    title="Voice & Editorial"
                    desc="Defines coverage scope and how every agent writes."
                    {...paneEditProps}
                  >
                    <Field label="Coverage scope" hint="What we cover">
                      <Textarea
                        value={form.coverageScope}
                        onChange={(v) => setForm({ ...form, coverageScope: v })}
                        disabled={!isEditing}
                        rows={3}
                      />
                    </Field>
                    <Field label="Out of scope" hint="What we do NOT cover">
                      <Textarea
                        value={form.coverageExcluded}
                        onChange={(v) =>
                          setForm({ ...form, coverageExcluded: v })
                        }
                        disabled={!isEditing}
                        rows={2}
                      />
                    </Field>
                    <Field label="Content pillars" hint="Recurring themes">
                      <ChipInput
                        values={form.contentPillars}
                        onChange={(v) =>
                          setForm({ ...form, contentPillars: v })
                        }
                        disabled={!isEditing}
                        placeholder="add pillar + Enter"
                      />
                    </Field>
                    <Field
                      label="Brand voice"
                      hint="Tone, formality, do's & don'ts"
                    >
                      <Textarea
                        value={form.brandVoice}
                        onChange={(v) => setForm({ ...form, brandVoice: v })}
                        disabled={!isEditing}
                        rows={3}
                      />
                    </Field>
                    <Field
                      label="Forbidden words"
                      hint="Words agents must never use"
                    >
                      <ChipInput
                        values={form.forbiddenWords}
                        onChange={(v) =>
                          setForm({ ...form, forbiddenWords: v })
                        }
                        disabled={!isEditing}
                        placeholder="leverage, vibrant, …"
                      />
                    </Field>
                  </Pane>
                )}

                {active === "mission" && (
                  <Pane
                    title="Mission & Audience"
                    desc="Why we exist, where we're going, who we serve."
                    {...paneEditProps}
                  >
                    <Field label="Mission" hint="Why we exist">
                      <Textarea
                        value={form.mission}
                        onChange={(v) => setForm({ ...form, mission: v })}
                        disabled={!isEditing}
                        rows={3}
                      />
                    </Field>
                    <Field label="Vision" hint="North star">
                      <Textarea
                        value={form.vision}
                        onChange={(v) => setForm({ ...form, vision: v })}
                        disabled={!isEditing}
                        rows={3}
                      />
                    </Field>
                    <Field label="Target audience" hint="ICP — who we serve">
                      <Textarea
                        value={form.targetAudience}
                        onChange={(v) =>
                          setForm({ ...form, targetAudience: v })
                        }
                        disabled={!isEditing}
                        rows={2}
                      />
                    </Field>
                    <Field label="USPs" hint="What makes us different">
                      <ChipInput
                        values={form.usps}
                        onChange={(v) => setForm({ ...form, usps: v })}
                        disabled={!isEditing}
                        placeholder="add unique selling point"
                      />
                    </Field>
                  </Pane>
                )}

                {active === "output" && (
                  <Pane
                    title="Output"
                    desc="What we make and sell. Agents reference this for BD + production."
                    {...paneEditProps}
                  >
                    <Field label="Core offering" hint="What we make/sell">
                      <Textarea
                        value={form.coreOffering}
                        onChange={(v) => setForm({ ...form, coreOffering: v })}
                        disabled={!isEditing}
                        rows={3}
                      />
                    </Field>
                    <Field label="Service catalog">
                      <ChipInput
                        values={form.serviceCatalog}
                        onChange={(v) =>
                          setForm({ ...form, serviceCatalog: v })
                        }
                        disabled={!isEditing}
                        placeholder="research, ghostwriting, advisory…"
                      />
                    </Field>
                  </Pane>
                )}

                {active === "contact" && (
                  <Pane
                    title="Contact"
                    desc="How people reach the company."
                    {...paneEditProps}
                  >
                    <Field label="Primary email">
                      <TextInput
                        value={form.contactEmail}
                        onChange={(v) => setForm({ ...form, contactEmail: v })}
                        disabled={!isEditing}
                        placeholder="hello@…"
                        type="email"
                      />
                    </Field>
                    <Field label="Sales / BD email">
                      <TextInput
                        value={form.salesEmail}
                        onChange={(v) => setForm({ ...form, salesEmail: v })}
                        disabled={!isEditing}
                        placeholder="bd@…"
                        type="email"
                      />
                    </Field>
                    <Field label="Phone">
                      <TextInput
                        value={form.phone}
                        onChange={(v) => setForm({ ...form, phone: v })}
                        disabled={!isEditing}
                      />
                    </Field>
                  </Pane>
                )}

                {active === "presence" && (
                  <Pane
                    title="Presence"
                    desc="Owned media URLs + social handles."
                    {...paneEditProps}
                  >
                    <SubGroup label="Web">
                      <Field label="Website">
                        <TextInput
                          value={form.websiteUrl}
                          onChange={(v) => setForm({ ...form, websiteUrl: v })}
                          disabled={!isEditing}
                          placeholder="https://…"
                        />
                      </Field>
                      <Field label="Blog">
                        <TextInput
                          value={form.blogUrl}
                          onChange={(v) => setForm({ ...form, blogUrl: v })}
                          disabled={!isEditing}
                          placeholder="https://…"
                        />
                      </Field>
                      <Field label="Newsletter">
                        <TextInput
                          value={form.newsletterUrl}
                          onChange={(v) =>
                            setForm({ ...form, newsletterUrl: v })
                          }
                          disabled={!isEditing}
                          placeholder="https://…"
                        />
                      </Field>
                      <Field label="Docs">
                        <TextInput
                          value={form.docsUrl}
                          onChange={(v) => setForm({ ...form, docsUrl: v })}
                          disabled={!isEditing}
                          placeholder="https://…"
                        />
                      </Field>
                    </SubGroup>

                    <SubGroup label="Social handles">
                      {KNOWN_SOCIAL_PLATFORMS.map((p) => (
                        <Field key={p.key} label={p.label}>
                          <TextInput
                            value={form.socialHandles[p.key] ?? ""}
                            onChange={(v) =>
                              setForm({
                                ...form,
                                socialHandles: {
                                  ...form.socialHandles,
                                  [p.key]: v,
                                },
                              })
                            }
                            disabled={!isEditing}
                            placeholder={p.placeholder}
                          />
                        </Field>
                      ))}
                    </SubGroup>
                  </Pane>
                )}

                {active === "crypto" && (
                  <Pane
                    title="Crypto-native"
                    desc="Wallet + chain coverage signals to Web3 audiences."
                    {...paneEditProps}
                  >
                    <Field
                      label="Treasury address"
                      hint="Wallet for client payments"
                    >
                      <TextInput
                        value={form.treasuryAddress}
                        onChange={(v) =>
                          setForm({ ...form, treasuryAddress: v })
                        }
                        disabled={!isEditing}
                        placeholder="0x… or Solana base58"
                      />
                    </Field>
                    <Field label="Chains covered">
                      <ChipInput
                        values={form.chainsCovered}
                        onChange={(v) =>
                          setForm({ ...form, chainsCovered: v })
                        }
                        disabled={!isEditing}
                        placeholder="Solana, Ethereum, Base…"
                      />
                    </Field>
                  </Pane>
                )}

                {active === "overview" && (
                  <Pane
                    title="Overview"
                    desc="Activity stats and pause / resume controls."
                  >
                    {isPaused && (
                      <Alert variant="warning">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-semibold text-amber-300">
                              Paused — agent activity is frozen
                            </p>
                            <p className="mt-1 text-[11px] text-amber-200/70">
                              Since{" "}
                              {company.pausedAt &&
                                new Date(company.pausedAt).toLocaleString()}
                              {company.pausedReason
                                ? ` · "${company.pausedReason}"`
                                : ""}
                            </p>
                          </div>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => void onResume()}
                            disabled={saving}
                          >
                            <Play className="size-3" />
                            Resume
                          </Button>
                        </div>
                      </Alert>
                    )}

                    {stats && (
                      <Card variant="recessed" padding="md">
                        <div className="flex items-center gap-8 text-[11px] text-white/65">
                          <Stat label="Agents" value={stats.agentsCount} />
                          <Stat label="Tasks" value={stats.tasksCount} />
                          <Stat
                            label="Memory"
                            value={stats.memoryEntriesCount}
                            muted
                          />
                          <div className="ml-auto text-[10px] text-white/35">
                            Created{" "}
                            {new Date(company.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                      </Card>
                    )}

                    {company.kickoffState === "completed" &&
                      onOpenMeetingReplay && (
                        <Card variant="recessed" padding="md">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-white/85">
                                Kickoff meeting
                              </p>
                              <p className="mt-0.5 text-[11px] text-white/50">
                                Replay the team's first conversation —
                                introductions and first-week commitments.
                              </p>
                            </div>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={onOpenMeetingReplay}
                            >
                              <PlayCircle className="size-3" />
                              Replay
                            </Button>
                          </div>
                        </Card>
                      )}

                    {!isPaused && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-white/35 mb-2">
                          State
                        </div>
                        {pauseConfirm ? (
                          <Card variant="recessed" padding="md">
                            <p className="text-xs text-amber-200/90 mb-3">
                              Pausing freezes all agent activity for this
                              company. You can resume anytime — no data is lost.
                            </p>
                            <Textarea
                              value={pauseReason}
                              onChange={setPauseReason}
                              rows={2}
                              placeholder="Reason (optional)"
                            />
                            <div className="mt-3 flex items-center gap-2">
                              <Button
                                variant="warning"
                                size="sm"
                                onClick={() => void onConfirmPause()}
                                disabled={saving}
                              >
                                <Pause className="size-3" />
                                Confirm pause
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                  setPauseConfirm(false);
                                  setPauseReason("");
                                }}
                              >
                                Cancel
                              </Button>
                            </div>
                          </Card>
                        ) : (
                          <Button
                            variant="warning"
                            size="sm"
                            onClick={() => setPauseConfirm(true)}
                          >
                            <Pause className="size-3" />
                            Pause company
                          </Button>
                        )}
                      </div>
                    )}
                  </Pane>
                )}
              </>
            )}
          </div>

          {company && form && isEditing && (
            <div
              className="border-t border-white/5 px-5 py-3 flex items-center justify-between"
              style={{ background: "rgba(20,20,24,0.6)" }}
            >
              <p className="text-[11px] text-white/45">
                {dirty ? (
                  <>
                    <AlertTriangle className="inline size-3 mr-1 text-amber-300/80" />
                    Unsaved changes
                  </>
                ) : (
                  "Editing — no changes yet"
                )}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCancelEdit}
                  disabled={saving}
                >
                  <X className="size-3" />
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void onSave()}
                  disabled={!dirty || saving}
                >
                  <Save className="size-3" />
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppWindow>
  );
}

// ── Sidebar + form helpers ───────────────────────────────────────────────────

function Sidebar({
  active,
  onSelect,
  isPaused,
}: {
  active: SectionId;
  onSelect: (id: SectionId) => void;
  isPaused: boolean;
}) {
  return (
    <aside
      className="shrink-0 border-r border-white/5 overflow-y-auto"
      style={{
        width: 200,
        background: "rgba(15,15,18,0.6)",
      }}
    >
      <div className="px-2 py-3">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          const isActive = active === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              className={`
                w-full flex items-start gap-2 px-2.5 py-2 rounded-lg
                text-left transition-all
                ${
                  isActive
                    ? "bg-white/10 text-white/90"
                    : "text-white/55 hover:bg-white/5 hover:text-white/80"
                }
              `}
            >
              <Icon className="size-3.5 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium leading-snug flex items-center gap-1.5">
                  {s.label}
                  {s.id === "overview" && isPaused && (
                    <span className="size-1.5 rounded-full bg-amber-400" />
                  )}
                </div>
                <div
                  className={`text-[10px] mt-0.5 leading-snug ${isActive ? "text-white/45" : "text-white/30"}`}
                >
                  {s.hint}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

const inputCls =
  "w-full rounded-lg bg-white/5 border border-white/10 px-3 py-1.5 text-[12px] text-white placeholder:text-white/30 focus:outline-none focus:border-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

function Pane({
  title,
  desc,
  canEdit,
  editing,
  onEdit,
  children,
}: {
  title: string;
  desc?: string;
  canEdit?: boolean;
  editing?: boolean;
  onEdit?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white/90">{title}</h2>
          {desc && <p className="mt-0.5 text-[11px] text-white/45">{desc}</p>}
        </div>
        {canEdit && !editing && onEdit && (
          <Button variant="secondary" size="sm" onClick={onEdit}>
            <Pencil className="size-3" />
            Edit
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-3.5">{children}</div>
    </div>
  );
}

function SubGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="text-[10px] uppercase tracking-wide text-white/35 -mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <label className="text-[11px] uppercase tracking-wide text-white/40">
          {label}
          {required && <span className="text-amber-300/80 ml-1">*</span>}
        </label>
        {hint && <span className="text-[10px] text-white/30">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// Read-only renderer for single-line / multi-line text values. Empty
// values render as a muted em-dash so the field row still occupies space
// (layout doesn't jump between view ↔ edit).
function FieldView({
  value,
  multiline,
}: {
  value: string | null | undefined;
  multiline?: boolean;
}) {
  const v = (value ?? "").trim();
  if (!v) {
    return <span className="text-[12px] text-white/30">—</span>;
  }
  return (
    <span
      className={`text-[12px] text-white/80 ${multiline ? "whitespace-pre-line leading-relaxed" : ""}`}
    >
      {v}
    </span>
  );
}

function ChipView({ values }: { values: string[] }) {
  if (values.length === 0) {
    return <span className="text-[12px] text-white/30">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((v, i) => (
        <span
          key={`${v}-${i}`}
          className="inline-flex rounded-md bg-white/8 px-2 py-0.5 text-[11px] text-white/75"
        >
          {v}
        </span>
      ))}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  disabled,
  placeholder,
  type,
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  type?: string;
  maxLength?: number;
}) {
  if (disabled) return <FieldView value={value} />;
  return (
    <input
      type={type ?? "text"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      className={inputCls}
    />
  );
}

function Textarea({
  value,
  onChange,
  disabled,
  rows = 3,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  rows?: number;
  placeholder?: string;
}) {
  if (disabled) return <FieldView value={value} multiline />;
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      placeholder={placeholder}
      className={`${inputCls} resize-y leading-relaxed`}
    />
  );
}

function DateInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  if (disabled) {
    const formatted = value
      ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "";
    return <FieldView value={formatted} />;
  }
  return (
    <input
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={inputCls}
    />
  );
}

function ChipInput({
  values,
  onChange,
  disabled,
  placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  if (disabled) return <ChipView values={values} />;
  const [draft, setDraft] = useState("");
  const commit = () => {
    const v = draft.trim();
    if (!v) return;
    if (values.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap gap-1.5 rounded-lg bg-white/5 border border-white/10 px-2 py-1.5">
      {values.map((v, i) => (
        <span
          key={`${v}-${i}`}
          className="inline-flex items-center gap-1 rounded-md bg-white/10 px-2 py-0.5 text-[11px] text-white/80"
        >
          {v}
          <button
            type="button"
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="text-white/40 hover:text-white"
            aria-label={`remove ${v}`}
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={values.length === 0 ? placeholder : ""}
        className="flex-1 min-w-25 bg-transparent border-none outline-none text-[12px] text-white placeholder:text-white/30"
      />
    </div>
  );
}

function Stat({
  label,
  value,
  muted,
}: {
  label: string;
  value: number;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-white/35">
        {label}
      </span>
      <span
        className={`text-base font-semibold ${muted ? "text-white/45" : "text-white/85"}`}
      >
        {value}
      </span>
    </div>
  );
}

