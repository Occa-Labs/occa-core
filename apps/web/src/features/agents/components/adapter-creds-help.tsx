"use client";

import type { AdapterType } from "@occa/shared/types";

// Inline code chip used throughout the help panels.
function C({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-white/8 px-1 py-0.5 font-mono text-[11px] text-white/75">
      {children}
    </code>
  );
}

function HelpField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-white/65">
        {label}
      </p>
      <div className="space-y-1.5 text-[12px] leading-relaxed text-white/50">
        {children}
      </div>
    </div>
  );
}

// Per-adapter "where do I find the gateway URL + key" tutorial. Rendered
// inside a FloatingPanel from the deploy + switch-runtime modals. Each
// runtime is reached over a gateway (BYORT), so all three explain the URL
// + bearer the host owner exposes.
export function AdapterCredsHelp({ adapter }: { adapter: AdapterType }) {
  if (adapter === "openclaw") {
    return (
      <div className="space-y-4 px-4 py-4">
        <p className="text-[12px] leading-relaxed text-white/45">
          OpenClaw is a self-hosted runtime (protocol-v3 over WebSocket, with
          Ed25519 device auth). You run the gateway; OCCA connects to it and
          owns identity, context, and orchestration.
        </p>

        <HelpField label="Gateway URL">
          <p>
            The gateway&apos;s public WebSocket endpoint, always <C>wss://</C>{" "}
            (TLS). The OpenClaw daemon binds a loopback port (
            <C>gateway.port</C> in <C>~/.openclaw/openclaw.json</C>, default{" "}
            <C>18789</C>); you front it with Caddy or nginx + a TLS cert so it
            is reachable as <C>wss://your-host</C>.
          </p>
          <p>
            OCCA hosted gateway: <C>wss://gateway.occa.team</C>.
          </p>
        </HelpField>

        <HelpField label="API key">
          <p>
            The bearer token from <C>~/.openclaw/openclaw.json</C> on the
            gateway box. It scopes the session that OCCA opens. One gateway can
            host many agents on the same token.
          </p>
        </HelpField>

        <HelpField label="What happens on switch">
          <p>
            On first connect OCCA generates an Ed25519 device keypair and runs
            the <C>device.pair</C> flow against the gateway, then provisions the
            agent (<C>openclawAgentId</C>) and seeds its workspace. The keypair
            + device token are persisted and reused, so later moves skip
            re-pairing. If your gateway requires manual pairing approval,
            approve the pending device once on the gateway side.
          </p>
        </HelpField>
      </div>
    );
  }

  if (adapter === "claude-code") {
    return (
      <div className="space-y-4 px-4 py-4">
        <p className="text-[12px] leading-relaxed text-white/45">
          Claude Code runs on a Claude subscription via a Claude Gateway you
          host (BYORT). The gateway wraps <C>claude -p</C> over HTTP; OCCA never
          spawns <C>claude</C> itself, it always talks to your gateway. The
          per-agent knob is the model (<C>sonnet</C> / <C>opus</C> /{" "}
          <C>haiku</C>).
        </p>

        <HelpField label="Gateway URL">
          <p>
            The public <C>https://</C> URL of the Claude Gateway service.
            Install <C>claude</C> on the host, log in, then run the gateway:{" "}
            <C>CLAUDE_GATEWAY_TOKEN=… CLAUDE_GATEWAY_PORT=8718 pnpm gateway</C>.
            It binds dual-stack by default (port <C>8718</C>); front it with
            Caddy + TLS so it is reachable as <C>https://your-host</C>.
          </p>
          <p>
            For local dev, run a gateway on the same box and use{" "}
            <C>http://localhost:8718</C>.
          </p>
        </HelpField>

        <HelpField label="API key">
          <p>
            The <C>CLAUDE_GATEWAY_TOKEN</C> you set when starting the gateway,
            sent as <C>Authorization: Bearer</C>. It is the only secret OCCA
            stores; the host&apos;s Claude login never leaves the box. The probe
            hits <C>GET /v1/health</C> with it to verify the connection.
          </p>
        </HelpField>

        <HelpField label="Billing">
          <p>
            Headless <C>claude -p</C> runs on the host&apos;s Claude plan. From
            2026-06-15 it draws from the separate Agent SDK credit, not the
            interactive limit. One gateway can serve many agents.
          </p>
        </HelpField>
      </div>
    );
  }

  return (
    <div className="space-y-4 px-4 py-4">
      <p className="text-[12px] leading-relaxed text-white/45">
        Hermes (Nous Research) is driven over an OpenAI-compatible HTTP
        gateway. OCCA holds a public HTTPS URL + bearer and calls{" "}
        <C>/v1/chat/completions</C> per agent turn. One box serves many agents.
      </p>

      <HelpField label="Gateway URL">
        <p>
          The public <C>https://</C> URL fronting the Hermes API server (
          <C>https://</C>, not OpenClaw&apos;s <C>wss://</C>).
        </p>
        <p>
          On the VPS, enable it in <C>~/.hermes/.env</C>:{" "}
          <C>API_SERVER_ENABLED=true</C>, <C>HOST=127.0.0.1</C>,{" "}
          <C>PORT=8642</C>, run <C>hermes gateway</C>, then front it with Caddy
          (<C>reverse_proxy localhost:8642</C>) + TLS. Result:{" "}
          <C>https://your-host</C>.
        </p>
        <p>
          OCCA hosted box: <C>https://hermes.occa.team</C>.
        </p>
      </HelpField>

      <HelpField label="API key">
        <p>
          The <C>API_SERVER_KEY</C> value you set in <C>~/.hermes/.env</C>, sent
          as <C>Authorization: Bearer</C>. OCCA&apos;s probe hits{" "}
          <C>GET /v1/capabilities</C> with it to verify the connection.
        </p>
        <p>
          To rotate: change <C>API_SERVER_KEY</C> on the VPS, restart{" "}
          <C>hermes-gateway.service</C>, then use Rotate bearer on each Hermes
          deployment.
        </p>
      </HelpField>

      <HelpField label="Multi-agent on one box">
        <p>
          Many OCCA agents can share one Hermes URL + key. They are isolated by
          a per-agent session key (<C>agent:&lt;id&gt;:task:&lt;id&gt;</C>),
          which scopes both conversation history and long-term memory. Saves
          you running a box per agent.
        </p>
      </HelpField>
    </div>
  );
}
