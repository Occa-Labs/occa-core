"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { companiesApi } from "@/lib/api";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";

interface CreateCompanyModalProps {
  open: boolean;
  onClose: () => void;
  /** Fired after the company is created — caller refetches + closes. */
  onCreated: () => void;
}

// Minimal create-company flow, opened once the $OCCA gate clears (see
// CreateCompanyCard). Single field today (name); profile fields land via
// the company OS later.
export function CreateCompanyModal({
  open,
  onClose,
  onCreated,
}: CreateCompanyModalProps) {
  const [name, setName] = useState("");
  const mutation = useMutation({
    mutationFn: (companyName: string) => companiesApi.create({ name: companyName }),
    onSuccess: () => {
      setName("");
      onCreated();
    },
  });
  const trimmed = name.trim();

  return (
    <Modal open={open} onClose={onClose} title="Create a company" width="min(440px, 92vw)">
      <form
        className="space-y-5 px-6 py-7"
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) mutation.mutate(trimmed);
        }}
      >
        <div className="space-y-2">
          <label className="text-xs font-medium text-white/55">Company name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Crypoch"
            className="h-11 w-full rounded-xl bg-white/8 px-4 text-sm text-white outline-none placeholder:text-white/30 focus:bg-white/12"
          />
        </div>
        {mutation.isError && (
          <p className="text-xs text-red-300">
            Couldn&apos;t create the company. Try again.
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          disabled={!trimmed || mutation.isPending}
        >
          {mutation.isPending ? "Creating…" : "Create company"}
        </Button>
      </form>
    </Modal>
  );
}
