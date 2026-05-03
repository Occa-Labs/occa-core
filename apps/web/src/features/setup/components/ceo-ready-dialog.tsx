"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { SpeakerBadge } from "@/components/ui/speaker-badge";

interface CeoReadyDialogProps {
  ceoName: string;
  onStart: () => void;
}

const TYPING_SPEED = 35;

export function CeoReadyDialog({ ceoName, onStart }: CeoReadyDialogProps) {
  const text = `${ceoName} is ready for you. Come on, I'll walk you over.`;
  const [displayedText, setDisplayedText] = useState("");
  const [isTyping, setIsTyping] = useState(true);
  const [visible, setVisible] = useState(false);
  const skipRef = useRef(false);
  const calledRef = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    setDisplayedText("");
    setIsTyping(true);
    skipRef.current = false;
    let i = 0;
    const id = setInterval(() => {
      if (skipRef.current) {
        setDisplayedText(text);
        setIsTyping(false);
        clearInterval(id);
        return;
      }
      i++;
      setDisplayedText(text.slice(0, i));
      if (i >= text.length) {
        setIsTyping(false);
        clearInterval(id);
      }
    }, TYPING_SPEED);
    return () => clearInterval(id);
  }, [text]);

  const advance = () => {
    if (isTyping) {
      skipRef.current = true;
      return;
    }
    if (calledRef.current) return;
    calledRef.current = true;
    onStart();
  };

  return (
    <div
      className="fixed inset-0 z-100 flex items-end justify-center"
      onClick={advance}
      onKeyDown={(e) => {
        if (e.key === "Enter") advance();
      }}
      role="dialog"
      tabIndex={0}
    >
      <div
        className="absolute inset-0 pointer-events-none transition-opacity duration-500"
        style={{
          opacity: visible ? 1 : 0,
          background:
            "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.25) 100%)",
        }}
      />
      <div
        className="relative w-full max-w-2xl mx-4 mb-8"
        onClick={(e) => {
          e.stopPropagation();
          advance();
        }}
      >
        {visible && (
        <Card
          spotlight
          padding="lg"
          className="relative animate-in fade-in duration-500"
        >
          <div className="absolute top-0 left-6 -translate-y-1/2 z-10">
            <SpeakerBadge name="Jia" />
          </div>
          <div className="mt-2 min-h-12 flex items-start">
            <p className="text-sm text-white/90 leading-relaxed">
              {displayedText}
              {isTyping && (
                <span className="inline-block w-0.5 h-4 bg-white/60 ml-0.5 animate-pulse align-middle" />
              )}
            </p>
          </div>
          {!isTyping && (
            <div className="mt-3 flex justify-end">
              <span className="rounded-full border border-white/20 bg-white/8 px-3 py-1 text-[11px] text-white/70 hover:bg-white/15 hover:text-white transition-colors cursor-pointer select-none">
                Continue ›
              </span>
            </div>
          )}
        </Card>
        )}
      </div>
    </div>
  );
}
