"use client";

export function DevicePairingHelp() {
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
          OCCA pairs as an{" "}
          <span className="text-white/85 font-medium">operator</span> device
          (not a node), so use{" "}
          <code className="font-mono text-white/85">openclaw devices</code>. SSH
          to your gateway host and run:
        </p>
        <pre className="bg-white/[0.07] border border-white/10 rounded-md px-2.5 py-2 font-mono text-[10.5px] text-white overflow-x-auto leading-snug">{`# preview the most recent pending request
openclaw devices approve --latest \\
  --token <gateway-token> \\
  --url ws://127.0.0.1:18789

# approve it (paste the requestId shown above)
openclaw devices approve <requestId> \\
  --token <gateway-token> \\
  --url ws://127.0.0.1:18789`}</pre>
        <p className="text-white/45 text-[10.5px] mt-1.5 leading-relaxed">
          <span className="text-white/65">Where to find things:</span>{" "}
          <code className="font-mono text-white/75">gateway-token</code> ={" "}
          <code className="font-mono text-white/75">auth.token</code> in{" "}
          <code className="font-mono text-white/75">
            ~/.openclaw/openclaw.json
          </code>
          . If you need to enumerate pending requests directly, read{" "}
          <code className="font-mono text-white/75">
            ~/.openclaw/devices/pending.json
          </code>{" "}
          —{" "}
          <code className="font-mono text-white/75">openclaw devices list</code>{" "}
          currently only renders the Paired section.
        </p>
      </div>

      <div>
        <p className="text-white/45 text-[10.5px] uppercase tracking-wide mb-1.5">
          Option 2 — Web UI
        </p>
        <ol className="space-y-1.5 list-decimal list-inside text-[11.5px]">
          <li>
            Open the OpenClaw control UI on the machine running your gateway
            (typically{" "}
            <code className="font-mono text-white/85">
              http://127.0.0.1:18789
            </code>
            , or whatever{" "}
            <code className="font-mono text-white/85">gateway.bind</code> / port
            you configured in{" "}
            <code className="font-mono text-white/85">
              ~/.openclaw/openclaw.json
            </code>
            ).
          </li>
          <li>
            Go to the <span className="text-white/85 font-medium">Devices</span>{" "}
            section (operator pairing requests live here, not under Nodes).
          </li>
          <li>
            Find OCCA's pending request and click{" "}
            <span className="text-white/85 font-medium">Approve</span>.
          </li>
          <li>
            Come back here and click{" "}
            <span className="text-white/85 font-medium">I've approved</span>.
          </li>
        </ol>
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
        <pre className="bg-white/[0.07] border border-white/10 rounded-md px-2.5 py-2 font-mono text-[10.5px] text-white overflow-x-auto leading-snug">{`"gateway": {
  "devices": {
    "pairing": {
      "autoApproveCidrs": ["192.168.1.0/24"]
    }
  }
}`}</pre>
        <p className="text-white/45 text-[10.5px] mt-1.5">
          Replace with your network's CIDR. Restart the gateway after editing.
          Operator-role pairings still need the requested scopes to be allowed
          by your gateway policy.
        </p>
      </div>
    </div>
  );
}
