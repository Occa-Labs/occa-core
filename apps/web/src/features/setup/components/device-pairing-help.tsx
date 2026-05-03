"use client";

export function deriveControlUiUrl(gatewayUrl: string): string {
  try {
    const u = new URL(gatewayUrl);
    const protocol = u.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${u.host}`;
  } catch {
    return gatewayUrl
      .replace(/^wss:/, "https:")
      .replace(/^ws:/, "http:")
      .replace(/\/$/, "");
  }
}

export function DevicePairingHelp({
  controlUiUrl,
}: {
  controlUiUrl: string;
}) {
  return (
    <div className="px-4 py-4 space-y-3.5 text-[12px] text-white/75 leading-relaxed">
      <p className="text-white/65">
        OpenClaw treats the first device as the trust root — it must be approved
        manually. After this one-time approval, future re-pairs from the same
        device are silent.
      </p>

      <div>
        <p className="text-white/45 text-[10.5px] uppercase tracking-wide mb-1.5">
          Option 1 — CLI (fastest, if you have SSH)
        </p>
        <p className="text-[11.5px] text-white/65 mb-1.5">
          SSH to your gateway host and run:
        </p>
        <pre className="bg-white/5 rounded-md px-2.5 py-2 font-mono text-[10.5px] text-white/80 overflow-x-auto leading-snug">{`# list pending pair requests
openclaw nodes pending

# approve by requestId from the list above
openclaw nodes approve <requestId>`}</pre>
        <p className="text-white/45 text-[10.5px] mt-1.5">
          Pending requests expire after 5 minutes.
        </p>
      </div>

      <div>
        <p className="text-white/45 text-[10.5px] uppercase tracking-wide mb-1.5">
          Option 2 — Web UI
        </p>
        <ol className="space-y-1.5 list-decimal list-inside text-[11.5px]">
          <li>
            Open the OpenClaw control UI:
            <a
              href={controlUiUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-1 font-mono text-[10.5px] text-blue-300/85 hover:text-blue-200 underline-offset-2 hover:underline break-all"
            >
              {controlUiUrl}
            </a>
          </li>
          <li>
            Go to the{" "}
            <span className="text-white/85 font-medium">Nodes</span> section in
            the left sidebar.
          </li>
          <li>
            Find OCCA's pending pair request and click{" "}
            <span className="text-white/85 font-medium">Approve</span>.
          </li>
          <li>
            Come back here and click{" "}
            <span className="text-white/85 font-medium">I've approved</span>.
          </li>
        </ol>
        <p className="text-white/45 text-[10.5px] mt-2 leading-relaxed">
          The same{" "}
          <span className="text-white/65 font-medium">Nodes</span> section also
          lets you click{" "}
          <span className="text-white/65 font-medium">Add Node</span> or{" "}
          <span className="text-white/65 font-medium">Pair Device</span> for a
          QR-code-based mobile pairing flow.
        </p>
      </div>

      <div>
        <p className="text-white/45 text-[10.5px] uppercase tracking-wide mb-1.5">
          Option 3 — Auto-approve from trusted network
        </p>
        <p className="text-[11.5px] text-white/65 mb-1.5">
          For repeat setups from a known network, add to{" "}
          <code className="font-mono text-white/85">
            ~/.openclaw/openclaw.json
          </code>
          :
        </p>
        <pre className="bg-white/5 rounded-md px-2.5 py-2 font-mono text-[10.5px] text-white/80 overflow-x-auto leading-snug">{`"gateway": {
  "nodes": {
    "pairing": {
      "autoApproveCidrs": ["192.168.1.0/24"]
    }
  }
}`}</pre>
        <p className="text-white/45 text-[10.5px] mt-1.5">
          Replace with your network's CIDR. Only applies to fresh device pairing
          without requested scopes.
        </p>
      </div>
    </div>
  );
}
