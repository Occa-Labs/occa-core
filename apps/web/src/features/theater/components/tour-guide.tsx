"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useCharacterAssets } from "../hooks/use-character-assets";
import {
  GUIDE_MODEL,
  GUIDE_POSITION,
  GUIDE_ROTATION_Y,
  ROOM_TOUR_WAYPOINTS,
  STANDING_IDLE_ANIM,
  WALK_SPEED,
  WALKING_ANIM,
} from "../constants";

interface TourGuideProps {
  active: boolean;
  /** When false, Jia stays at the spawn point in idle (intro phase —
   *  camera frames her face-to-face for the welcome line). Flip to true
   *  to start the walking tour. Defaults to true so existing callers
   *  that just toggle `active` keep working. */
  walkEnabled?: boolean;
  onTourEnd?: () => void;
  posRef: React.RefObject<THREE.Vector3>;
  forwardRef: React.RefObject<THREE.Vector3>;
  onDialog?: (text: string) => void;
  currentDialog?: string | null;
}

function shortestAngle(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

const TURN_SPEED = 4.0;
const ARRIVE_THRESHOLD = 0.2;
const MIN_SEGMENT = 0.3;
const SAME_POS_EPS = 0.05;
const HEARTBEAT_MIN_HOLD_MS = 1;
// Compress recorded `wp.t` heartbeat pauses to this fraction of their
// original duration. Recording captured slow user pauses; the playback
// feels snappier when held only ~10% as long.
const RECORDED_WAIT_FACTOR = 0.1;

type Waypoint = (typeof ROOM_TOUR_WAYPOINTS)[number];

// Drop micro-segments (< MIN_SEGMENT) so the walk loop doesn't kedutan
// across clustered samples. Keep dialog stops (load-bearing) and same-pos
// heartbeats (replay "look around" pauses).
function compactPath(raw: readonly Waypoint[]): Waypoint[] {
  const out: Waypoint[] = [];
  for (const wp of raw) {
    const last = out[out.length - 1];
    if (!last) {
      out.push(wp);
      continue;
    }
    const dx = wp.position.x - last.position.x;
    const dz = wp.position.z - last.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const samePos = dist < SAME_POS_EPS;
    if (samePos || wp.dialog) {
      out.push(wp);
      continue;
    }
    if (dist < MIN_SEGMENT) continue;
    out.push(wp);
  }
  return out;
}

export function TourGuide({
  active,
  walkEnabled = true,
  onTourEnd,
  posRef,
  forwardRef,
  onDialog,
}: TourGuideProps) {
  const path = useMemo(() => compactPath(ROOM_TOUR_WAYPOINTS), []);

  const groupRef = useRef<THREE.Group>(null);
  const wpIdxRef = useRef(0);
  const tourStartRef = useRef(0);
  const heartbeatHoldUntilRef = useRef(0);
  const spokenRef = useRef<Set<number>>(new Set());
  const onTourEndRef = useRef(onTourEnd);
  onTourEndRef.current = onTourEnd;
  const onDialogRef = useRef(onDialog);
  onDialogRef.current = onDialog;

  const {
    model,
    mixer,
    idleClip,
    actionClip: walkClip,
  } = useCharacterAssets({
    modelUrl: GUIDE_MODEL,
    idleAnimUrl: STANDING_IDLE_ANIM,
    actionAnimUrl: WALKING_ANIM,
    talkAnimUrl: STANDING_IDLE_ANIM,
  });

  const walkingRef = useRef(false);
  const setWalking = useCallback(
    (walking: boolean) => {
      if (walkingRef.current === walking) return;
      walkingRef.current = walking;
      if (!walkClip || !idleClip) return;
      const FADE = 0.25;
      if (walking) {
        const next = mixer.clipAction(walkClip).reset();
        next.play();
        mixer.clipAction(idleClip).crossFadeTo(next, FADE, true);
      } else {
        const next = mixer.clipAction(idleClip).reset();
        next.play();
        mixer.clipAction(walkClip).crossFadeTo(next, FADE, true);
      }
    },
    [mixer, walkClip, idleClip],
  );

  useEffect(() => {
    mixer.stopAllAction();
    if (idleClip) mixer.clipAction(idleClip).reset().fadeIn(0.3).play();
    return () => {
      mixer.stopAllAction();
    };
  }, [mixer, idleClip]);

  useEffect(() => {
    if (!active) return;
    if (groupRef.current) {
      groupRef.current.position.set(
        GUIDE_POSITION.x,
        GUIDE_POSITION.y,
        GUIDE_POSITION.z,
      );
      groupRef.current.rotation.y = GUIDE_ROTATION_Y;
    }
  }, [active]);

  // Reset the walk state machine each time the tour transitions from
  // intro → walking. Pinning the timer here (not in the `active` reset
  // above) keeps recorded `t` offsets aligned with when Jia actually
  // starts moving, regardless of how long the intro line lingered.
  useEffect(() => {
    if (!active || !walkEnabled) return;
    wpIdxRef.current = 0;
    tourStartRef.current = performance.now();
    heartbeatHoldUntilRef.current = 0;
    spokenRef.current = new Set();
  }, [active, walkEnabled]);

  const tmpDir = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, delta) => {
    if (!active) return;
    const group = groupRef.current;
    if (!group) return;
    mixer.update(delta);
    group.getWorldPosition(posRef.current);

    // Intro phase — Jia stands at spawn while the camera frames her
    // face-to-face for the welcome line. No walking, no waypoint progress.
    if (!walkEnabled) {
      setWalking(false);
      forwardRef.current.set(
        -Math.sin(group.rotation.y),
        0,
        -Math.cos(group.rotation.y),
      );
      return;
    }

    if (path.length === 0) {
      onTourEndRef.current?.();
      return;
    }
    if (wpIdxRef.current >= path.length) return;

    const idx = wpIdxRef.current;
    const wp = path[idx];
    const prev = idx > 0 ? path[idx - 1] : null;

    if (wp.dialog && !spokenRef.current.has(idx)) {
      spokenRef.current.add(idx);
      onDialogRef.current?.(wp.dialog);
    }

    const isHeartbeat =
      !!prev &&
      Math.abs(prev.position.x - wp.position.x) < SAME_POS_EPS &&
      Math.abs(prev.position.z - wp.position.z) < SAME_POS_EPS;

    if (isHeartbeat) {
      setWalking(false);
      const dyaw = shortestAngle(group.rotation.y, wp.rotationY);
      if (Math.abs(dyaw) > 0.02) {
        const stepRot =
          Math.sign(dyaw) * Math.min(Math.abs(dyaw), TURN_SPEED * delta);
        group.rotation.y += stepRot;
        forwardRef.current.set(
          -Math.sin(group.rotation.y),
          0,
          -Math.cos(group.rotation.y),
        );
        return;
      }
      if (heartbeatHoldUntilRef.current === 0) {
        const elapsed = performance.now() - tourStartRef.current;
        const recordedWait =
          typeof wp.t === "number" ? Math.max(0, wp.t - elapsed) : 0;
        // Compress recorded heartbeat pauses — keep proportional pacing
        // (so longer recorded holds still feel longer) but at a fraction
        // of the original duration so the tour reads as snappy.
        const compressedWait = recordedWait * RECORDED_WAIT_FACTOR;
        heartbeatHoldUntilRef.current =
          performance.now() + Math.max(HEARTBEAT_MIN_HOLD_MS, compressedWait);
      }
      if (performance.now() < heartbeatHoldUntilRef.current) return;
      heartbeatHoldUntilRef.current = 0;
      wpIdxRef.current++;
      // The tour can end on a heartbeat (last waypoint = "stop and look
      // around" pose). Fire `onTourEnd` here too so the camera zooms out
      // — without this, the walking branch never runs and the tour just
      // freezes on Jia in idle.
      if (wpIdxRef.current >= path.length) {
        setWalking(false);
        onTourEndRef.current?.();
      }
      return;
    }

    const dx = wp.position.x - group.position.x;
    const dz = wp.position.z - group.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist >= ARRIVE_THRESHOLD) {
      tmpDir.set(dx, 0, dz).normalize();
      // Walk yaw is derived from movement direction — single source of
      // authority. Recorded rotationY is intentionally ignored here;
      // it's only used in heartbeat samples above.
      const tgtYaw = Math.atan2(tmpDir.x, tmpDir.z);
      const dyaw = shortestAngle(group.rotation.y, tgtYaw);
      if (Math.abs(dyaw) > 0.001) {
        const stepRot =
          Math.sign(dyaw) * Math.min(Math.abs(dyaw), TURN_SPEED * delta);
        group.rotation.y += stepRot;
      }
      forwardRef.current.set(
        -Math.sin(group.rotation.y),
        0,
        -Math.cos(group.rotation.y),
      );
      const step = Math.min(WALK_SPEED * delta, dist);
      group.position.addScaledVector(tmpDir, step);
      setWalking(true);
      return;
    }

    wpIdxRef.current++;
    if (wpIdxRef.current >= path.length) {
      setWalking(false);
      onTourEndRef.current?.();
    }
  });

  if (!active) return null;
  return (
    <group
      ref={groupRef}
      position={[GUIDE_POSITION.x, GUIDE_POSITION.y, GUIDE_POSITION.z]}
      rotation={[0, GUIDE_ROTATION_Y, 0]}
    >
      <primitive object={model} />
    </group>
  );
}
