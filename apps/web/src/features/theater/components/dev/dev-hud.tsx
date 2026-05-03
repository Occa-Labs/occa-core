"use client";

export function RecorderHud() {
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
      <div className="glass rounded-2xl px-5 py-3 text-xs text-white/70 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-red-400 animate-pulse">●</span>
          <span className="font-medium text-white/90 tracking-wide">WAYPOINT RECORDER</span>
        </div>
        <div className="flex gap-6">
          <div className="space-y-1">
            <div className="flex justify-center">
              <kbd className="glass px-2 py-0.5 rounded text-[10px]">↑</kbd>
            </div>
            <div className="flex gap-1">
              <kbd className="glass px-2 py-0.5 rounded text-[10px]">←</kbd>
              <kbd className="glass px-2 py-0.5 rounded text-[10px]">↓</kbd>
              <kbd className="glass px-2 py-0.5 rounded text-[10px]">→</kbd>
            </div>
            <div className="text-[10px] text-white/40 text-center">move / turn</div>
          </div>
          <div className="border-l border-white/10 pl-6 flex items-center">
            <span className="text-[10px] text-white/50 leading-relaxed max-w-45">
              Walk Jia to destination, then click <span className="text-white/80">Stop Recording</span> — path opens in a modal ready to copy.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function RecordedPathModal({
  code, copied, onCopy, onClose,
}: {
  code: string;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-60 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-heavy rounded-2xl p-5 w-full max-w-xl mx-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-white/90">Recorded Walk Path</span>
          <button onClick={onClose} className="text-white/40 hover:text-white/80 transition-colors text-xs">✕</button>
        </div>
        <pre className="text-[11px] text-white/80 bg-black/40 rounded-xl p-3 max-h-[50vh] overflow-auto font-mono leading-relaxed">
          {code}
        </pre>
        <div className="flex justify-end">
          <button
            onClick={onCopy}
            className="rounded-xl bg-white text-black px-4 py-2 text-xs font-medium hover:bg-white/90 transition-colors"
          >
            {copied ? "Copied!" : "Copy to clipboard"}
          </button>
        </div>
      </div>
    </div>
  );
}
