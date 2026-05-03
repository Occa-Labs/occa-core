import * as THREE from "three";

// Procedural Canvas2D textures used to replace the stock screen materials
// in Demo.glb (the office model ships with Facebook / arcade-game art on
// the monitors, which is too on-the-nose for OCCA's office sim).
//
// flipY=false matches the GLTF UV convention so the canvas content lands
// right-side-up on the monitor mesh without baking a flip into the draw.

const W = 512;
const H = 384;

function makeCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  return { canvas, ctx };
}

function finalize(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Module-level cache. The dashboard texture is static so we can safely
// share one instance across every monitor mesh that swaps to it,
// avoiding the cost of redrawing the canvas on every HMR cycle.
let _researchTex: THREE.CanvasTexture | null = null;

// Mock research dashboard: header bar, bar chart, sparkline, KPI tiles,
// data table. Looks busy enough to read as "someone's doing work".
export function createResearchDashboardTexture(): THREE.CanvasTexture {
  if (_researchTex) return _researchTex;
  const { canvas, ctx } = makeCanvas();

  // Background
  ctx.fillStyle = "#0f1623";
  ctx.fillRect(0, 0, W, H);

  // Top bar
  ctx.fillStyle = "#172033";
  ctx.fillRect(0, 0, W, 38);
  ctx.fillStyle = "#5fdcff";
  ctx.font = "bold 18px system-ui, sans-serif";
  ctx.fillText("◆ RESEARCH", 14, 25);
  ctx.fillStyle = "#9aa4b8";
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText("market signals · on-chain · v0.6", 142, 25);

  // KPI tiles row
  const tiles: Array<[string, string, string]> = [
    ["TVL", "$48.2M", "+3.4%"],
    ["VOL 24h", "12.7K", "-1.1%"],
    ["AGENTS", "247", "+18"],
  ];
  let x = 16;
  for (const [label, value, delta] of tiles) {
    ctx.fillStyle = "#1c2638";
    ctx.fillRect(x, 50, 152, 56);
    ctx.fillStyle = "#9aa4b8";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(label, x + 10, 66);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.fillText(value, x + 10, 88);
    ctx.fillStyle = delta.startsWith("+") ? "#00ff88" : "#ff6b6b";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(delta, x + 10, 102);
    x += 162;
  }

  // Bar chart
  ctx.fillStyle = "#1c2638";
  ctx.fillRect(16, 118, 240, 130);
  ctx.fillStyle = "#9aa4b8";
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillText("WEEKLY VOLUME", 24, 134);
  const bars = [54, 72, 41, 88, 63, 95, 110];
  const barW = 28;
  const barGap = 4;
  const baseY = 240;
  const maxBar = Math.max(...bars);
  for (let i = 0; i < bars.length; i++) {
    const h = (bars[i] / maxBar) * 90;
    ctx.fillStyle = i === bars.length - 1 ? "#5fdcff" : "#3a8ec8";
    ctx.fillRect(28 + i * (barW + barGap), baseY - h, barW, h);
  }

  // Sparkline
  ctx.fillStyle = "#1c2638";
  ctx.fillRect(266, 118, 230, 130);
  ctx.fillStyle = "#9aa4b8";
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillText("PRICE — 30D", 274, 134);
  const points = [
    [0, 70], [20, 60], [40, 80], [60, 55], [80, 75],
    [100, 50], [120, 65], [140, 40], [160, 55], [180, 30],
    [200, 45],
  ];
  ctx.strokeStyle = "#00ff88";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const px = 280 + points[i][0];
    const py = 145 + points[i][1];
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Data table
  ctx.fillStyle = "#1c2638";
  ctx.fillRect(16, 260, 480, 110);
  ctx.fillStyle = "#9aa4b8";
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillText("RECENT TRACES", 24, 276);

  ctx.font = "11px system-ui, sans-serif";
  const rows = [
    ["t-12s",  "agent.cto",        "trace.start", "ok"],
    ["t-31s",  "agent.researcher", "skill.exec",  "ok"],
    ["t-1m",   "agent.cmo",        "msg.outbound","ok"],
    ["t-2m",   "agent.cto",        "trace.end",   "ok"],
    ["t-4m",   "agent.head_eng",   "skill.fail",  "err"],
  ];
  let y = 294;
  for (const row of rows) {
    ctx.fillStyle = "#9aa4b8";
    ctx.fillText(row[0], 26, y);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(row[1], 84, y);
    ctx.fillStyle = "#9aa4b8";
    ctx.fillText(row[2], 232, y);
    ctx.fillStyle = row[3] === "ok" ? "#00ff88" : "#ff6b6b";
    ctx.fillText(row[3], 380, y);
    y += 14;
  }

  _researchTex = finalize(canvas);
  return _researchTex;
}
