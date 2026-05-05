"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useCharacterAssets } from "../hooks/use-character-assets";
import {
  ARRIVE_THRESHOLD,
  CEO_MEETING_POSITION,
  GUIDE_MODEL,
  GUIDE_POSITION,
  GUIDE_ROTATION_Y,
  STANDING_IDLE_ANIM,
  WALKING_ANIM,
  WALK_SPEED,
  WALK_WAYPOINTS,
  WP_THRESHOLD,
} from "../constants";

interface GuideCharacterProps {
  visible: boolean;
  walking: boolean;
  onArrived?: () => void;
  posRef: React.RefObject<THREE.Vector3>;
  forwardRef: React.RefObject<THREE.Vector3>;
  manualPosRef?: React.RefObject<THREE.Vector3> | null;
}

export function GuideCharacter({
  visible,
  walking,
  onArrived,
  posRef,
  forwardRef,
  manualPosRef,
}: GuideCharacterProps) {
  const groupRef = useRef<THREE.Group>(null);
  const visibleRef = useRef(visible);
  const walkingRef = useRef(walking);
  const arrivedRef = useRef(false);
  const wpIndexRef = useRef(0);
  visibleRef.current = visible;
  walkingRef.current = walking;

  // Standing guide — Jia walks across the office. Talk slot is unused, we
  // reuse the idle URL so useLoader cache only fetches 2 distinct FBX.
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

  useEffect(() => {
    mixer.stopAllAction();
    if (idleClip) mixer.clipAction(idleClip).reset().fadeIn(0.3).play();
    return () => {
      mixer.stopAllAction();
    };
  }, [mixer, idleClip]);

  useEffect(() => {
    const FADE = 0.25;
    if (walking && walkClip) {
      const to = mixer.clipAction(walkClip).reset();
      to.play();
      idleClip && mixer.clipAction(idleClip).crossFadeTo(to, FADE, true);
    } else if (!walking && idleClip) {
      const to = mixer.clipAction(idleClip).reset();
      to.play();
      walkClip && mixer.clipAction(walkClip).crossFadeTo(to, FADE, true);
    }
  }, [walking, mixer, idleClip, walkClip]);

  useEffect(() => {
    if (walking) {
      arrivedRef.current = false;
      wpIndexRef.current = 0;
    }
  }, [walking]);

  const tmpDir = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, delta) => {
    if (!visibleRef.current) return;
    mixer.update(delta);
    const group = groupRef.current;
    if (!group) return;

    // Dev recording: position driven externally by WaypointRecorder
    if (manualPosRef) {
      group.position.set(
        manualPosRef.current.x,
        GUIDE_POSITION.y,
        manualPosRef.current.z,
      );
      group.getWorldPosition(posRef.current);
      const { x: fx, z: fz } = forwardRef.current;
      if (Math.abs(fx) + Math.abs(fz) > 0.01) {
        let diff = Math.atan2(fx, fz) - group.rotation.y;
        if (diff > Math.PI) diff -= 2 * Math.PI;
        if (diff < -Math.PI) diff += 2 * Math.PI;
        group.rotation.y += diff / 5;
      }
      return;
    }

    group.getWorldPosition(posRef.current);

    if (!walkingRef.current || arrivedRef.current) return;

    const isLast = wpIndexRef.current >= WALK_WAYPOINTS.length - 1;
    const wp =
      WALK_WAYPOINTS[Math.min(wpIndexRef.current, WALK_WAYPOINTS.length - 1)];
    const dist = group.position.distanceTo(wp.position);
    const thresh = isLast ? ARRIVE_THRESHOLD : WP_THRESHOLD;

    if (dist < thresh) {
      if (isLast) {
        arrivedRef.current = true;
        tmpDir
          .copy(CEO_MEETING_POSITION)
          .sub(group.position)
          .setY(0)
          .normalize();
        group.rotation.y = Math.atan2(tmpDir.x, tmpDir.z);
        forwardRef.current.copy(tmpDir).negate();
        onArrived?.();
      } else {
        wpIndexRef.current++;
      }
    } else {
      tmpDir.copy(wp.position).sub(group.position).setY(0).normalize();
      const step = Math.min(WALK_SPEED * delta, dist);
      group.position.addScaledVector(tmpDir, step);
      group.rotation.y = Math.atan2(tmpDir.x, tmpDir.z);
      forwardRef.current.copy(tmpDir).negate();
    }
  });

  return (
    <group
      ref={groupRef}
      position={[GUIDE_POSITION.x, GUIDE_POSITION.y, GUIDE_POSITION.z]}
      rotation={[0, GUIDE_ROTATION_Y, 0]}
      visible={visible}
    >
      <primitive object={model} />
    </group>
  );
}
