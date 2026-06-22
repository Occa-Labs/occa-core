"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import type { ToolCredentialField } from "@occa/shared/types";

type ToolFieldHint = ToolCredentialField;

interface CredentialFieldsFormProps {
  title: string;
  fields: ToolFieldHint[];
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export function CredentialFieldsForm({
  title,
  fields,
  values,
  onChange,
}: CredentialFieldsFormProps) {
  return (
    <div className="space-y-3">
      <p className="text-[11px] uppercase tracking-wider text-white/55">
        {title}
      </p>
      {fields.map((field) => (
        <FieldRow
          key={field.name}
          field={field}
          value={values[field.name]}
          onChange={(v) => onChange({ ...values, [field.name]: v })}
        />
      ))}
    </div>
  );
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: ToolFieldHint;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const [revealed, setRevealed] = useState(false);

  if (field.type === "boolean") {
    return (
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 rounded cursor-pointer"
        />
        <span className="flex-1">
          <span className="text-[12px] text-white/85">{field.name}</span>
          {field.description && (
            <span className="block text-[10px] text-white/45 mt-0.5">
              {field.description}
            </span>
          )}
        </span>
      </label>
    );
  }

  const isSecret = field.secret;
  // Long string values (e.g. a locked house-style prompt) get a resizeable
  // textarea instead of a cramped single-line input.
  const isMultiline = field.multiline === true && field.type === "string";
  const stringValue =
    value === undefined || value === null
      ? ""
      : typeof value === "string" || typeof value === "number"
        ? String(value)
        : "";

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="text-[12px] text-white/80">
          {field.name}
          {field.required && <span className="text-amber-300/80 ml-1">*</span>}
        </label>
        {isSecret && (
          <button
            type="button"
            onClick={() => setRevealed(!revealed)}
            className="text-[10px] text-white/45 hover:text-white/75 transition-colors cursor-pointer inline-flex items-center gap-1"
          >
            {revealed ? (
              <>
                <EyeOff className="size-3" /> Hide
              </>
            ) : (
              <>
                <Eye className="size-3" /> Show
              </>
            )}
          </button>
        )}
      </div>
      {isMultiline ? (
        <textarea
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          rows={5}
          className="mt-1 w-full px-3 py-2 rounded-md bg-white/5 border border-white/10 text-[13px] font-mono leading-relaxed text-white/90 placeholder:text-white/30 focus:outline-none focus:border-white/30 resize-y min-h-24"
        />
      ) : (
        <input
          type={
            field.type === "number"
              ? "number"
              : isSecret && !revealed
                ? "password"
                : "text"
          }
          value={stringValue}
          onChange={(e) =>
            onChange(
              field.type === "number"
                ? Number(e.target.value)
                : e.target.value,
            )
          }
          spellCheck={false}
          autoComplete={isSecret ? "new-password" : undefined}
          className="mt-1 w-full px-3 py-1.5 rounded-md bg-white/5 border border-white/10 text-[13px] font-mono text-white/90 placeholder:text-white/30 focus:outline-none focus:border-white/30"
        />
      )}
      {field.description && (
        <p className="text-[10px] text-white/40 mt-1">{field.description}</p>
      )}
    </div>
  );
}
