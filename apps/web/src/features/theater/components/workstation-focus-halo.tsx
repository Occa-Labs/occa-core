"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { HALO_FLOOR_OFFSET } from "../constants";

interface WorkstationFocusHaloProps {
  position: { x: number; y: number; z: number };
}

const INNER_RADIUS = 1.0;
const OUTER_RADIUS = 1.4;
const COLOR        = "#facc15";    // amber — distinct from agent status colors
const BASE_OPACITY = 0.35;
const PULSE_AMP    = 0.25;
const PULSE_HZ     = 1.6;

// Bright pulsing ring drawn on the floor under a workstation that's been
// focused via the dev tools panel. Sits slightly above the workstation's
// own y so it renders cleanly on basement chairs (negative y) too.
export function WorkstationFocusHalo({ position }: WorkstationFocusHaloProps) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!meshRef.current) return;
    const mat = meshRef.current.material as THREE.MeshBasicMaterial;
    mat.opacity = BASE_OPACITY + PULSE_AMP * Math.sin(state.clock.elapsedTime * PULSE_HZ);
  });

  return (
    <mesh
      ref={meshRef}
      position={[position.x, position.y + HALO_FLOOR_OFFSET, position.z]}
      rotation={[-Math.PI / 2, 0, 0]}
      raycast={() => null}
    >
      <ringGeometry args={[INNER_RADIUS, OUTER_RADIUS, 48]} />
      <meshBasicMaterial
        color={COLOR}
        transparent
        opacity={BASE_OPACITY}
        toneMapped={false}
        depthWrite={false}
      />
    </mesh>
  );
}
