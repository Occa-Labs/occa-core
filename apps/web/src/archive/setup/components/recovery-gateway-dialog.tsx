"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { SpeakerBadge } from "@/components/ui/speaker-badge";
import type { UseOnboardingResult } from "../hooks/use-onboarding";

interface RecoveryGatewayDialogProps {
  onboarding: UseOnboardingResult;
}

// Re-pair dialog for chain-first recovery: company + CEO already exist on
// chain (rebuilt by `/api/me`), only Tier 3 (gateway URL + API key) was
// wiped. We skip the full onboarding form — name/role are already known —
// and ask only for what the user must re-supply on a new device.
export function RecoveryGatewayDialog({
  onboarding,
}: RecoveryGatewayDialogProps) {
  const status = onboarding.status;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(t);
  }, []);

  if (status.kind !== "recovery-needed") return null;

  const { company, ceoName } = status;
  const { gatewayUrl, apiKey } = onboarding.form.adapterConfig;
  const canSubmit = gatewayUrl.trim().length > 0 && apiKey.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center"
      role="dialog"
    >
      <div
        className="absolute inset-0 pointer-events-none transition-opacity duration-500"
        style={{
          opacity: visible ? 1 : 0,
          background:
            "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.35) 100%)",
        }}
      />
      <div className="relative w-full max-w-md mx-4">
        {visible && (
          <Card
            spotlight
            padding="lg"
            className="relative animate-in fade-in duration-500"
          >
            <div className="absolute top-0 left-6 -translate-y-1/2 z-10">
              <SpeakerBadge name="Jia" />
            </div>
            <div className="mt-2 space-y-3">
              <p className="text-sm text-white/90 leading-relaxed">
                Welcome back to <span className="font-medium">{company.name}</span>.
                I restored <span className="font-medium">{ceoName}</span> from the
                chain. Your company and CEO are intact. We just need to pair
                the gateway again on this device.
              </p>
              <div className="space-y-2 pt-1">
                <label className="block text-xs text-white/60">
                  Gateway URL
                  <input
                    type="url"
                    autoFocus
                    value={gatewayUrl}
                    onChange={(e) =>
                      onboarding.setAdapterConfig({ gatewayUrl: e.target.value })
                    }
                    placeholder="http://localhost:3010"
                    className="mt-1 w-full rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30"
                  />
                </label>
                <label className="block text-xs text-white/60">
                  API key
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) =>
                      onboarding.setAdapterConfig({ apiKey: e.target.value })
                    }
                    placeholder="oc_•••"
                    className="mt-1 w-full rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30"
                  />
                </label>
              </div>
              {status.kind === "recovery-needed" && (
                <p className="text-[11px] text-white/40">
                  Adapter config is local only. It never leaves this device
                  except to reach your gateway.
                </p>
              )}
              <div className="flex justify-end pt-2">
                <Button
                  disabled={!canSubmit}
                  onClick={() => void onboarding.repairGateway()}
                >
                  Re-pair gateway
                </Button>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

interface RecoveryErrorDialogProps {
  onboarding: UseOnboardingResult;
}

// Surfaces error from a failed re-pair attempt; lets the user edit creds
// and retry without going back through the full flow.
export function RecoveryErrorDialog({
  onboarding,
}: RecoveryErrorDialogProps) {
  const status = onboarding.status;
  if (status.kind !== "error") return null;
  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center"
      role="dialog"
    >
      <div className="relative w-full max-w-md mx-4">
        <Card spotlight padding="lg">
          <Alert variant="error">
            <p className="text-sm">
              Re-pair failed: <span className="font-mono">{status.message}</span>
            </p>
          </Alert>
          <div className="flex justify-end pt-3">
            <Button onClick={() => void onboarding.refresh()}>
              Try again
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
