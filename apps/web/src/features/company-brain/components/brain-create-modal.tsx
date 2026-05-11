"use client";

import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Modal } from "../../../components/ui/modal";
import { Select } from "../../../components/ui/select";
import { useCreateBrainFile } from "../api/use-brain-mutations";

const VISIBILITY_OPTIONS = [
  { value: "all", label: "All agents" },
  { value: "tier:head", label: "Heads + CEO" },
  { value: "ceo_only", label: "CEO only" },
] as const;

const PATH_PREFIX = "/brain/";
const PATH_SUFFIX = ".md";

interface BrainCreateModalProps {
  open: boolean;
  onClose: () => void;
}

export function BrainCreateModal({ open, onClose }: BrainCreateModalProps) {
  const [slug, setSlug] = useState("");
  const [content, setContent] = useState("");
  const [visibility, setVisibility] =
    useState<(typeof VISIBILITY_OPTIONS)[number]["value"]>("all");
  const [error, setError] = useState<string | null>(null);
  const create = useCreateBrainFile();

  const fullPath = `${PATH_PREFIX}${slug}${PATH_SUFFIX}`;
  const slugValid = /^[a-z0-9][a-z0-9-]*$/.test(slug);
  const canSubmit = slugValid && content.trim().length > 0 && !create.isPending;

  const handleSubmit = async () => {
    setError(null);
    try {
      await create.mutateAsync({
        path: fullPath,
        content,
        visibility,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New brain file"
      subtitle="Lowercase slug, hyphens allowed."
      width="min(640px, 94vw)"
      footer={
        <div className="flex items-center justify-end gap-2 px-4 py-3">
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <label className="flex flex-col gap-1 text-sm text-white/70">
          <span>Path</span>
          <div className="flex items-center gap-1 font-mono text-sm">
            <span className="text-white/40">{PATH_PREFIX}</span>
            <Input
              value={slug}
              onChange={(e) =>
                setSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))
              }
              placeholder="glossary"
              className="flex-1"
            />
            <span className="text-white/40">{PATH_SUFFIX}</span>
          </div>
          {!slugValid && slug.length > 0 && (
            <span className="text-xs text-amber-400">
              Slug must start with a letter or digit and contain only
              lowercase letters, digits, and hyphens.
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm text-white/70">
          <span>Visibility</span>
          <Select
            value={visibility}
            onChange={(e) =>
              setVisibility(
                e.target.value as (typeof VISIBILITY_OPTIONS)[number]["value"],
              )
            }
          >
            {VISIBILITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-white/70">
          <span>Content (markdown)</span>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={12}
            className="w-full resize-y rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-sm text-white outline-none focus:border-white/30"
            placeholder="# Your knowledge goes here"
          />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </Modal>
  );
}
