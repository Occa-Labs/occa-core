"use client";

import { useEffect, useState } from "react";
import { Coins, Plus } from "lucide-react";
import {
  OCCA_CREATE_GATE_PERCENT,
  OCCA_TOKEN_MINT,
} from "@/lib/env-flags";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Spinner } from "@/components/ui/spinner";
import { useOccaCreateGate } from "@/features/home/api/use-occa-create-gate";

const PUMP_FUN_URL = `https://pump.fun/coin/${OCCA_TOKEN_MINT}`;

const compactFmt = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 2,
});

interface CreateCompanyCardProps {
  hasCompany: boolean;
  walletAddress: string | null;
  /** Proceed into the create / onboarding flow once the gate clears. */
  onProceed: () => void;
}

// The dashboard's Create-company entry. The OS is open to everyone, but
// spinning up a company is gated: the wallet must hold at least
// OCCA_CREATE_GATE_PERCENT of the $OCCA supply. The check runs lazily on
// click — no mainnet RPC until the user actually tries.
export function CreateCompanyCard({
  hasCompany,
  walletAddress,
  onProceed,
}: CreateCompanyCardProps) {
  const [armed, setArmed] = useState(false);
  const [showGate, setShowGate] = useState(false);
  const gate = useOccaCreateGate(armed ? walletAddress : null);

  useEffect(() => {
    if (!armed) return;
    if (gate.status === "ready") {
      if (gate.eligible) {
        setArmed(false);
        onProceed();
      } else {
        setShowGate(true);
      }
    } else if (gate.status === "error") {
      setShowGate(true);
    }
  }, [armed, gate.status, gate.eligible, onProceed]);

  const checking =
    armed && (gate.status === "idle" || gate.status === "loading");

  const closeGate = () => {
    setShowGate(false);
    setArmed(false);
  };

  return (
    <>
      <Card
        interactive
        padding="lg"
        onClick={() => !checking && setArmed(true)}
        className="flex min-h-44 flex-col items-center justify-center gap-3 text-center"
      >
        <div className="flex size-11 items-center justify-center rounded-2xl bg-white/8">
          {checking ? (
            <Spinner className="size-5 text-white/80" />
          ) : (
            <Plus className="size-5 text-white/80" />
          )}
        </div>
        <div>
          <p className="text-sm font-semibold text-white">
            {checking
              ? "Checking eligibility…"
              : hasCompany
                ? "Create a company"
                : "Create your first company"}
          </p>
          <p className="mt-1 text-xs text-white/45">
            Requires holding {OCCA_CREATE_GATE_PERCENT}% of $OCCA supply.
          </p>
        </div>
      </Card>

      <Modal
        open={showGate}
        onClose={closeGate}
        title="Holders only"
        width="min(440px, 92vw)"
      >
        <div className="space-y-6 px-6 py-7 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-white/8">
            <Coins className="size-6 text-white/85" />
          </div>

          <p className="text-[13px] leading-relaxed text-white/60">
            Creating a company on OCCA needs a wallet holding at least{" "}
            {OCCA_CREATE_GATE_PERCENT}% of the total $OCCA supply. Keeps
            companies in the hands of people with real skin in the game.
          </p>

          {gate.status === "error" ? (
            <div className="rounded-2xl border border-white/7 bg-white/4 px-5 py-4 text-left">
              <p className="text-[12px] leading-relaxed text-white/55">
                Couldn&apos;t read your $OCCA balance right now. Check your
                connection and try again.
              </p>
            </div>
          ) : (
            <div className="space-y-3 rounded-2xl border border-white/7 bg-white/4 px-5 py-4 text-left">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-[11px] font-medium text-white/45">
                  Your balance
                </span>
                <span
                  className="text-[15px] font-semibold tracking-tight"
                  style={{ color: "rgb(252,165,165)" }}
                >
                  {compactFmt.format(gate.balance)} $OCCA
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-[11px] font-medium text-white/45">
                  Required
                </span>
                <span className="text-[13px] font-medium text-white/70">
                  {compactFmt.format(gate.required)} $OCCA
                </span>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <a
              href={PUMP_FUN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="block"
            >
              <Button variant="primary" size="lg" block>
                Get $OCCA
              </Button>
            </a>
            <Button variant="secondary" size="lg" block onClick={closeGate}>
              Maybe later
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
