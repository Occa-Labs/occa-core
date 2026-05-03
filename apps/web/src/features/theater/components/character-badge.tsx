"use client";

import { useMemo } from "react";
import { Billboard, Text } from "@react-three/drei";
import * as THREE from "three";

function makePillShape(w: number, h: number): THREE.Shape {
  const r = h / 2;
  const x = -w / 2;
  const y = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y,     x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x,     y + h, x,     y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x,     y,     x + r, y);
  s.closePath();
  return s;
}

export function CharacterBadge({
  role, status, dotColor, position,
}: {
  role: string;
  status: string;
  dotColor: string;
  position: [number, number, number];
}) {
  const S    = 0.12;
  const dotR = 0.036;
  const gap  = 0.055;
  const padX = 0.10;
  const padY = 0.06;

  const roleW   = role.length   * S * 0.58;
  const statusW = status.length * S * 0.50;
  const innerW  = dotR * 2 + gap + roleW + gap * 0.7 + statusW;
  const bgW     = innerW + padX * 2;
  const bgH     = S + padY * 2;

  const startX  = -innerW / 2;
  const dotX    = startX + dotR;
  const roleX   = startX + dotR * 2 + gap + roleW / 2;
  const statusX = startX + dotR * 2 + gap + roleW + gap * 0.7 + statusW / 2;

  const pill = useMemo(() => makePillShape(bgW, bgH), [bgW, bgH]);

  return (
    <Billboard position={position}>
      <mesh renderOrder={1}>
        <shapeGeometry args={[pill]} />
        <meshBasicMaterial color="#0a0a0a" transparent opacity={0.78} depthWrite={false} />
      </mesh>

      {/* Dot — toneMapped=false so the pill doesn't render over it */}
      <mesh position={[dotX, 0, 0.005]} renderOrder={2}>
        <circleGeometry args={[dotR, 20]} />
        <meshBasicMaterial color={dotColor} transparent toneMapped={false} depthWrite={false} />
      </mesh>

      <Text
        position={[roleX, 0, 0.005]}
        fontSize={S}
        color="#ffffff"
        anchorX="center"
        anchorY="middle"
        renderOrder={2}
      >
        {role}
      </Text>

      <Text
        position={[statusX, 0, 0.005]}
        fontSize={S * 0.82}
        color="#9096a8"
        anchorX="center"
        anchorY="middle"
        renderOrder={2}
      >
        {status}
      </Text>
    </Billboard>
  );
}
