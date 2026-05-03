"use client";

import { type ButtonHTMLAttributes, forwardRef } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "warning" | "success";
export type ButtonSize    = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders a full-width block button. */
  block?: boolean;
}

// ── Style maps ────────────────────────────────────────────────────────────────

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: "rgba(255,255,255,0.12)",
    border: "1px solid rgba(255,255,255,0.14)",
    color: "rgba(255,255,255,0.90)",
  },
  secondary: {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.09)",
    color: "rgba(255,255,255,0.65)",
  },
  ghost: {
    background: "transparent",
    border: "1px solid transparent",
    color: "rgba(255,255,255,0.55)",
  },
  danger: {
    background: "rgba(239,68,68,0.14)",
    border: "1px solid transparent",
    color: "rgb(252,165,165)",
  },
  warning: {
    background: "rgba(245,158,11,0.14)",
    border: "1px solid transparent",
    color: "rgb(252,211,77)",
  },
  success: {
    background: "linear-gradient(150deg, #059669 0%, #047857 100%)",
    border: "1px solid transparent",
    color: "rgba(255,255,255,0.95)",
  },
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-7 px-3 gap-1.5 text-[11px] rounded-lg",
  md: "h-8 px-4 gap-1.5 text-[12px] rounded-xl",
  lg: "h-9 px-5 gap-2   text-[13px] rounded-xl",
};

// ── Component ─────────────────────────────────────────────────────────────────

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "secondary",
      size = "md",
      block = false,
      className = "",
      style,
      disabled,
      children,
      ...props
    },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled}
        className={`
          inline-flex items-center justify-center font-medium
          transition-all duration-150 select-none
          disabled:opacity-35 disabled:cursor-not-allowed
          ${sizeClasses[size]}
          ${block ? "w-full" : ""}
          ${variant === "ghost" ? "hover:bg-white/8" : "hover:brightness-110 active:brightness-95"}
          ${className}
        `}
        style={{ ...variantStyles[variant], ...style }}
        {...props}
      >
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
