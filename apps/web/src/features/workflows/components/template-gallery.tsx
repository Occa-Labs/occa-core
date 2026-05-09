"use client";

// Template gallery shown when the user clicks "New" in WorkflowsWindow.
// A blank YAML editor is hostile to users who don't know the schema, so
// every "new workflow" flow starts here: pick a template card, drop into
// the editor with a working example pre-filled. The blank template
// preserves the from-scratch path for power users.

import { ArrowRight } from "lucide-react";
import {
  WORKFLOW_TEMPLATES,
  type WorkflowTemplate,
} from "../templates";

interface TemplateGalleryProps {
  onPick: (template: WorkflowTemplate) => void;
  onCancel: () => void;
}

export function TemplateGallery({ onPick, onCancel: _onCancel }: TemplateGalleryProps) {
  return (
    <div className="px-5 py-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {WORKFLOW_TEMPLATES.map((tpl) => (
          <TemplateCard
            key={tpl.id}
            template={tpl}
            onPick={() => onPick(tpl)}
          />
        ))}
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  onPick,
}: {
  template: WorkflowTemplate;
  onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      className="group text-left flex flex-col gap-2 p-4 rounded-lg border border-white/10 bg-white/3 hover:bg-white/8 hover:border-white/20 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="text-sm font-medium text-white/90">
            {template.label}
          </div>
        </div>
        <ArrowRight className="size-3.5 text-white/30 group-hover:text-white/70 transition-colors shrink-0 mt-1" />
      </div>
      <p className="text-[11px] text-white/55 leading-relaxed">
        {template.summary}
      </p>
    </button>
  );
}
