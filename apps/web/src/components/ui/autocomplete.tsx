"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { surface, shadow } from "@/components/ui/tokens";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AutocompleteOption {
  value: string;
  /** Display label — defaults to value if omitted. */
  label?: string;
  description?: string;
  disabled?: boolean;
}

export interface AutocompleteProps {
  /** Current text value. */
  value: string;
  onChange: (value: string) => void;
  /** Called when the user confirms a suggestion (click or Enter). */
  onSelect?: (option: AutocompleteOption) => void;
  options: AutocompleteOption[] | string[];
  placeholder?: string;
  label?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
  /** Restrict input to values that exist in options. Default: false (freeform). */
  strict?: boolean;
  className?: string;
  inputClassName?: string;
  id?: string;
}

// ── Normalise options ─────────────────────────────────────────────────────────

function normalise(options: AutocompleteOption[] | string[]): AutocompleteOption[] {
  return options.map((o) => (typeof o === "string" ? { value: o } : o));
}

// ── Suggestion list portal ────────────────────────────────────────────────────

function SuggestionList({
  options,
  anchor,
  activeIndex,
  currentValue,
  onSelect,
  onClose,
}: {
  options: AutocompleteOption[];
  anchor: DOMRect;
  activeIndex: number;
  currentValue: string;
  onSelect: (opt: AutocompleteOption) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0, ready: false });

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const gap = 4;
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const elH = el.offsetHeight;

    let top = anchor.bottom + gap;
    if (top + elH > vp.h - 8) top = anchor.top - elH - gap;

    setPos({ top, left: anchor.left, width: anchor.width, ready: true });
  }, [anchor]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLButtonElement>("[data-active='true']");
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return createPortal(
    <div
      ref={listRef}
      role="listbox"
      className="fixed z-400 py-1 rounded-xl overflow-y-auto"
      style={{
        ...surface.elevated,
        boxShadow: shadow.lg,
        top: pos.ready ? pos.top : anchor.bottom + 4,
        left: pos.ready ? pos.left : anchor.left,
        width: pos.ready ? pos.width : anchor.width,
        maxHeight: 240,
        opacity: pos.ready ? 1 : 0,
        transform: pos.ready ? "translateY(0)" : "translateY(-4px)",
        transition: "opacity 130ms ease, transform 130ms cubic-bezier(0.16,1,0.3,1)",
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {options.map((opt, i) => {
        const label = opt.label ?? opt.value;
        const isActive = i === activeIndex;
        const isSelected = opt.value === currentValue;
        const isDisabled = opt.disabled === true;
        return (
          <button
            key={opt.value}
            role="option"
            aria-selected={isSelected}
            aria-disabled={isDisabled}
            data-active={isActive}
            onMouseDown={(e) => {
              if (isDisabled) { e.preventDefault(); return; }
              onSelect(opt);
              onClose();
            }}
            className={`
              w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[12px] text-left
              transition-colors duration-75
              ${isDisabled
                ? "text-white/25 cursor-not-allowed"
                : isActive
                  ? "bg-white/10 text-white/95"
                  : "text-white/70 hover:bg-white/6 hover:text-white/90"
              }
            `}
          >
            <span className="flex-1 min-w-0">
              <span className="font-medium">{label}</span>
              {opt.description && (
                <span className="ml-2 text-white/25 text-[11px]">{opt.description}</span>
              )}
            </span>
            {isDisabled
              ? <span className="text-[10px] text-white/20 font-medium">taken</span>
              : isSelected
                ? <Check className="size-3 shrink-0 text-emerald-400" />
                : null
            }
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export const Autocomplete = forwardRef<HTMLInputElement, AutocompleteProps>(
  (
    {
      value,
      onChange,
      onSelect,
      options: rawOptions,
      placeholder,
      label,
      hint,
      error,
      disabled = false,
      className = "",
      inputClassName = "",
      id,
    },
    ref,
  ) => {
    const inputId = id ?? (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);
    const internalRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => internalRef.current!);

    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [anchor, setAnchor] = useState<DOMRect | null>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);

    const allOptions = normalise(rawOptions);

    // Filter: show matching options when the user is mid-typing. When
    // the value is empty OR exactly equals an existing option (i.e.
    // the user just confirmed a selection), show every option so they
    // can see alternatives without first clearing the field.
    const valueExactlyMatchesOption = allOptions.some(
      (o) => o.value === value || (o.label ?? o.value) === value,
    );
    const filtered =
      value.trim().length === 0 || valueExactlyMatchesOption
        ? allOptions
        : allOptions.filter((o) => {
            const lv = value.toLowerCase();
            return (
              (o.label ?? o.value).toLowerCase().includes(lv) ||
              o.value.toLowerCase().includes(lv)
            );
          });

    const showList = open && filtered.length > 0;

    const updateAnchor = useCallback(() => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (rect) setAnchor(rect);
    }, []);

    const handleFocus = useCallback(() => {
      updateAnchor();
      setOpen(true);
      setActiveIndex(-1);
    }, [updateAnchor]);

    const handleBlur = useCallback(() => {
      // Delay so onMouseDown on a list item fires first
      setTimeout(() => {
        setOpen(false);
        setActiveIndex(-1);
      }, 150);
    }, []);

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        onChange(e.target.value);
        updateAnchor();
        setOpen(true);
        setActiveIndex(-1);
      },
      [onChange, updateAnchor],
    );

    const handleConfirm = useCallback(
      (opt: AutocompleteOption) => {
        if (opt.disabled) return;
        onChange(opt.value);
        onSelect?.(opt);
        setOpen(false);
        setActiveIndex(-1);
      },
      [onChange, onSelect],
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!showList) {
          if (e.key === "ArrowDown") { updateAnchor(); setOpen(true); }
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIndex((i) => {
            let next = i + 1;
            while (next < filtered.length && filtered[next]?.disabled) next++;
            return next < filtered.length ? next : i;
          });
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIndex((i) => {
            let prev = i - 1;
            while (prev >= 0 && filtered[prev]?.disabled) prev--;
            return prev >= 0 ? prev : i;
          });
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (activeIndex >= 0 && filtered[activeIndex] && !filtered[activeIndex].disabled) {
            handleConfirm(filtered[activeIndex]);
          }
        } else if (e.key === "Escape") {
          setOpen(false);
          setActiveIndex(-1);
        }
      },
      [showList, filtered, activeIndex, handleConfirm, updateAnchor],
    );

    // Close on outside click
    useEffect(() => {
      if (!open) return;
      const handler = (e: MouseEvent) => {
        if (!wrapperRef.current?.contains(e.target as Node)) {
          setOpen(false);
          setActiveIndex(-1);
        }
      };
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }, [open]);

    return (
      <div ref={wrapperRef} className={`flex flex-col gap-1.5 ${className}`}>
        {label && (
          <label htmlFor={inputId} className="text-[11px] text-white/50 font-medium">
            {label}
          </label>
        )}

        <input
          ref={internalRef}
          id={inputId}
          role="combobox"
          aria-expanded={showList}
          aria-autocomplete="list"
          autoComplete="off"
          value={value}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className={`
            w-full rounded-xl px-3.5 py-2.5 text-[13px] text-white/85
            placeholder:text-white/22
            bg-white/5 ring-1 ring-inset
            transition-all duration-150 outline-none
            disabled:opacity-50 disabled:cursor-not-allowed
            ${error ? "ring-red-500/40 focus:ring-red-500/60" : "ring-white/10 focus:ring-white/22"}
            ${inputClassName}
          `}
        />

        {error && <p className="text-[11px] text-red-300/80">{error}</p>}
        {hint && !error && <p className="text-[11px] text-white/30">{hint}</p>}

        {showList && anchor && (
          <SuggestionList
            options={filtered}
            anchor={anchor}
            activeIndex={activeIndex}
            currentValue={value}
            onSelect={handleConfirm}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    );
  },
);
Autocomplete.displayName = "Autocomplete";
