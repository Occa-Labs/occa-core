"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { SpeakerBadge } from "@/components/ui/speaker-badge";

interface CeoIntroDialogProps {
  ceoName: string;
  companyName: string;
  onDone: () => void;
}

const TYPING_SPEED = 32;
const STEP_DELAY = 500;

function buildScript(ceoName: string, companyName: string) {
  return [
    {
      speaker: "Jia",
      text: `${ceoName}, this is the new owner. Just got here.`,
    },
    {
      speaker: ceoName,
      text: "Hey. Jia told me all about you. Glad to finally meet you.",
    },
    {
      speaker: "Jia",
      text: "I'll give you two some space. Just call if you need me.",
    },
    {
      speaker: ceoName,
      text: `${companyName} is mine to run. Ready when you are.`,
    },
    {
      speaker: ceoName,
      text: "First thing — I'll figure out what matters and start. Plan in your inbox shortly.",
    },
  ];
}

export function CeoIntroDialog({
  ceoName,
  companyName,
  onDone,
}: CeoIntroDialogProps) {
  const script = buildScript(ceoName, companyName);
  const [turnIndex, setTurnIndex] = useState(0);
  const [displayedText, setDisplayedText] = useState("");
  const [isTyping, setIsTyping] = useState(true);
  const [visible, setVisible] = useState(false);
  const skipRef = useRef(false);
  const doneFired = useRef(false);

  const currentTurn = script[turnIndex];
  const isLastTurn = turnIndex === script.length - 1;

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!currentTurn) return;
    setDisplayedText("");
    setIsTyping(true);
    skipRef.current = false;
    let i = 0;
    const id = setInterval(() => {
      if (skipRef.current) {
        setDisplayedText(currentTurn.text);
        setIsTyping(false);
        clearInterval(id);
        return;
      }
      i++;
      setDisplayedText(currentTurn.text.slice(0, i));
      if (i >= currentTurn.text.length) {
        setIsTyping(false);
        clearInterval(id);
      }
    }, TYPING_SPEED);
    return () => clearInterval(id);
  }, [turnIndex, currentTurn?.text]);

  const advance = () => {
    if (isTyping) {
      skipRef.current = true;
      return;
    }
    if (isLastTurn) {
      if (doneFired.current) return;
      doneFired.current = true;
      onDone();
      return;
    }
    setTimeout(() => setTurnIndex((p) => p + 1), STEP_DELAY);
  };

  if (!currentTurn) return null;
  const speakerKind = currentTurn.speaker === "Jia" ? "narrator" : "agent";

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
            "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.28) 100%)",
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
            <SpeakerBadge name={currentTurn.speaker} kind={speakerKind} />
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
                {isLastTurn ? "Let's go ›" : "Continue ›"}
              </span>
            </div>
          )}

          <div className="mt-4 flex items-center justify-center gap-1.5">
            {script.map((_, i) => (
              <div
                key={i}
                className="h-1 rounded-full transition-all duration-300"
                style={{
                  width: i === turnIndex ? 16 : 6,
                  backgroundColor:
                    i === turnIndex
                      ? "rgba(255,255,255,0.6)"
                      : i < turnIndex
                        ? "rgba(255,255,255,0.3)"
                        : "rgba(255,255,255,0.1)",
                }}
              />
            ))}
          </div>
        </Card>
        )}
      </div>
    </div>
  );
}
