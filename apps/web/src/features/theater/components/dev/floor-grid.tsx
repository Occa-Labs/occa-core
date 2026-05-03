"use client";

import { useMemo, useRef, useState } from "react";
import { type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { useDevMap, devMapActions, type MapKind } from "@/lib/dev-map-store";
import type { SceneBounds } from "../../types";

// Map editor 3D surface. Mounts only while `mode !== "off"` in the dev
// map store. Provides:
//   - A wide invisible plane covering the scene floor that captures
//     pointer events (raycast target for hover + click).
//   - A faint world-axis grid for orientation.
//   - One mesh that follows the hovered cell (cyan outline).
//   - One mesh for the pending cell (yellow, between 1st and 2nd click).
//   - One InstancedMesh for saved cells (semi-transparent blue).
//   - A facing arrow for each saved cell.
//
// Cell size = 1 world unit. Cells are anchored at integer (x, z).

const CELL_SIZE = 0.5;
const PLANE_Y = 0.005; // hair above floor to avoid z-fighting
const HOVER_COLOR = new THREE.Color("#22d3ee"); // tailwind cyan-400
const PENDING_COLOR = new THREE.Color("#facc15"); // tailwind yellow-400

// Kind-specific palette. Stand cells = blue; sit cells = emerald (green).
// Keeps the two pools visually separable when both are painted.
const KIND_FILL: Record<MapKind, THREE.Color> = {
  stand: new THREE.Color("#3b82f6"), // blue-500
  sit:   new THREE.Color("#10b981"), // emerald-500
};
const KIND_ARROW: Record<MapKind, THREE.Color> = {
  stand: new THREE.Color("#1d4ed8"), // blue-700
  sit:   new THREE.Color("#047857"), // emerald-700
};

interface FloorGridProps {
  bounds: SceneBounds | null;
}

// Snap a continuous world coordinate to the nearest cell *center*. Note:
// GridHelper draws LINES at integer-multiples of CELL_SIZE, so cell
// centers sit at offsets of CELL_SIZE/2 (e.g. for CELL_SIZE=0.5 cell
// centers are 0.25, 0.75, 1.25, …). Rounding to a multiple of CELL_SIZE
// — what we used to do — landed on line intersections, making the hover
// indicator straddle four cells instead of sitting in one.
const snap = (n: number) =>
  (Math.floor(n / CELL_SIZE) + 0.5) * CELL_SIZE;

export function FloorGrid({ bounds }: FloorGridProps) {
  const { mode, cells, pending } = useDevMap();
  const [hover, setHover] = useState<{ x: number; z: number } | null>(null);

  // Plane + grid sized to cover scene bounds. CRITICAL: grid is centered
  // at the world origin (0, 0) with an *even* total size so its line
  // positions land on integer X/Z. Anywhere else (e.g. centering at
  // ((minX+maxX)/2)) can produce half-integer line positions when the
  // bounds aren't symmetric, which makes the hover indicator's
  // `Math.round` snap miss the visible grid by 0.5 units. We instead pick
  // a square size that fully encloses bounds in both axes.
  const gridSize = useMemo(() => {
    if (!bounds) return 80;
    const [minX, minZ, maxX, maxZ] = bounds;
    const halfExtent = Math.max(
      Math.abs(minX),
      Math.abs(maxX),
      Math.abs(minZ),
      Math.abs(maxZ),
    );
    // Round up to next even integer so half-size is integer; cell lines
    // at -size/2 ... +size/2 in 1-unit steps then all land on integers.
    return Math.ceil(halfExtent) * 2;
  }, [bounds]);

  if (mode === "off") return null;

  return (
    <group>
      {/* Faint grid overlay for cell orientation. Major lines every
          CELL_SIZE. We override the GridHelper's default LineBasicMaterial
          via `attach="material"` so it can be transparent. */}
      <gridHelper
        args={[gridSize, gridSize / CELL_SIZE, "#22d3ee", "#22d3ee"]}
        position={[0, PLANE_Y, 0]}
      >
        <lineBasicMaterial
          attach="material"
          color="#22d3ee"
          transparent
          opacity={0.18}
          depthWrite={false}
        />
      </gridHelper>

      {/* Invisible raycast target. Catches pointer move + click events. */}
      <mesh
        position={[0, PLANE_Y, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          const x = snap(e.point.x);
          const z = snap(e.point.z);
          if (!hover || hover.x !== x || hover.z !== z) {
            setHover({ x, z });
          }
        }}
        onPointerOut={() => setHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          const x = snap(e.point.x);
          const z = snap(e.point.z);
          devMapActions.startOrToggle(x, z);
        }}
      >
        <planeGeometry args={[gridSize, gridSize]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* Saved cells. Static meshes — pool is small enough (≤200) that
          individual meshes are fine and simpler than an InstancedMesh. */}
      {cells.map((c) => (
        <SavedCell key={`${c.kind}:${c.x},${c.z}`} cell={c} />
      ))}

      {/* Pending cell — yellow, with a "rubber-band" line to the cursor so
          the user can preview the facing direction before the second click. */}
      {pending && (
        <PendingCell pending={pending} hover={hover} />
      )}

      {/* Hover preview — shown only when no pending and the user isn't
          hovering a same-kind saved cell. Letting hover render on top of a
          *different-kind* saved cell is intentional: that's how the user
          previews painting a sit cell where a stand cell already lives. */}
      {hover &&
        !pending &&
        !cells.some(
          (c) => c.x === hover.x && c.z === hover.z && c.kind === mode,
        ) && (
          <CellMesh
            x={hover.x}
            z={hover.z}
            color={HOVER_COLOR}
            opacity={0.35}
            outline
          />
        )}
    </group>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function CellMesh({
  x,
  z,
  color,
  opacity,
  outline,
}: {
  x: number;
  z: number;
  color: THREE.Color;
  opacity: number;
  outline?: boolean;
}) {
  return (
    <group position={[x, PLANE_Y + 0.001, z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[CELL_SIZE * 0.92, CELL_SIZE * 0.92]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={opacity}
          depthWrite={false}
        />
      </mesh>
      {outline && (
        <lineSegments rotation={[-Math.PI / 2, 0, 0]}>
          <edgesGeometry
            args={[new THREE.PlaneGeometry(CELL_SIZE * 0.96, CELL_SIZE * 0.96)]}
          />
          <lineBasicMaterial color={color} />
        </lineSegments>
      )}
    </group>
  );
}

function SavedCell({
  cell,
}: {
  cell: { x: number; z: number; rotationY: number; kind: MapKind };
}) {
  return (
    <>
      <CellMesh
        x={cell.x}
        z={cell.z}
        color={KIND_FILL[cell.kind]}
        opacity={0.45}
        outline
      />
      <FacingArrow
        x={cell.x}
        z={cell.z}
        rotationY={cell.rotationY}
        color={KIND_ARROW[cell.kind]}
      />
    </>
  );
}

function PendingCell({
  pending,
  hover,
}: {
  pending: { x: number; z: number };
  hover: { x: number; z: number } | null;
}) {
  // Live rotation from pending toward current hover, so the user sees the
  // facing direction snap as they move the cursor.
  const previewRot =
    hover && (hover.x !== pending.x || hover.z !== pending.z)
      ? Math.atan2(hover.x - pending.x, hover.z - pending.z)
      : null;

  return (
    <>
      <CellMesh
        x={pending.x}
        z={pending.z}
        color={PENDING_COLOR}
        opacity={0.55}
        outline
      />
      {previewRot !== null && (
        <FacingArrow
          x={pending.x}
          z={pending.z}
          rotationY={previewRot}
          color={PENDING_COLOR}
        />
      )}
    </>
  );
}

// Thin arrow on top of a cell pointing toward `rotationY`. atan2(dx, dz)
// → group's local +Z aligns with the facing direction after rotateY.
function FacingArrow({
  x,
  z,
  rotationY,
  color,
}: {
  x: number;
  z: number;
  rotationY: number;
  color: THREE.Color;
}) {
  const ref = useRef<THREE.Group>(null);
  return (
    <group
      ref={ref}
      position={[x, PLANE_Y + 0.01, z]}
      rotation={[0, rotationY, 0]}
    >
      {/* Shaft — thin rectangle along +Z. */}
      <mesh position={[0, 0, 0.25]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.06, 0.45]} />
        <meshBasicMaterial color={color} transparent opacity={0.9} depthWrite={false} />
      </mesh>
      {/* Arrowhead — cone with apex toward +Z (rotate +90 around X so the
          cone's local +Y becomes world +Z relative to the parent group). */}
      <mesh position={[0, 0, 0.55]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.1, 0.2, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.95} depthWrite={false} />
      </mesh>
    </group>
  );
}
