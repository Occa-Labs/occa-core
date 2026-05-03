"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { useCharacterAssets } from "../hooks/use-character-assets";
import {
  sittingIdleAnimFor,
  standingIdleAnimFor,
  SITTING_TALKING_ANIM,
  TYPING_ANIM,
} from "../constants";
import type { AgentStatus, RoleLayout } from "../types";
import { dotColorFor, statusLabelFor } from "../utils";
import { formatRoleLabel } from "@/lib/format-role";
import { CharacterBadge } from "./character-badge";

interface AgentCharacterProps {
  role: string;
  layout: RoleLayout;
  status: AgentStatus;
  ready: boolean;
  /** Fired when the user clicks the character. Undefined → not clickable
   *  (e.g. pre-provisioning placeholder, or cinematic in flight). */
  onClick?: () => void;
}

// Default seat height above each workstation's floor reference. Hips bone
// is anchored at `target.y + SEATED_HIPS_OFFSET` so the character lands on
// the cushion. Per-chair fine-tune: bump the workstation `y` in
// office-anchors.ts up/down (e.g. tall chairs +0.05, low ones -0.05).
const SEATED_HIPS_OFFSET = 0.7;
// Standing hip height above floor — the StandingIdle FBX rest pose lands
// the Hips bone roughly here, so anchoring at this Y plants feet on floor.
const STANDING_HIPS_OFFSET = 0.95;

// Distance-based animation throttle. Doesn't hide anything — character +
// badge always render. Just feeds the mixer at a lower frame granularity
// for distant agents (delta×N to keep animation speed correct), so 28+
// agents don't all eat full skinning-matrix-recompute cost every frame.
//   - distance < NEAR_FULL_DISTANCE → mixer.update every frame (full)
//   - else                          → mixer.update every THROTTLE_FRAMES
const NEAR_FULL_DISTANCE = 25;
const THROTTLE_FRAMES = 3;

// Module-level scratch — shared across all AgentCharacter useFrame
// callbacks (R3F frame loop is serial, safe). Avoids allocating a fresh
// THREE.Vector3 per agent per frame just to compute distance.
const _scratchPos = new THREE.Vector3();

export function AgentCharacter({
  role,
  layout,
  status,
  ready,
  onClick,
}: AgentCharacterProps) {
  const target = layout.position;
  const groupRef = useRef<THREE.Group>(null);
  const calibrated = useRef(false);
  const frameCount = useRef(0);
  // Throttle counter for distant-agent animation rate-limiting. Separate
  // from `frameCount` (which is consumed during the calibration phase).
  const throttleCounter = useRef(0);
  // Badge sits in world space (sibling of the group, not a child) because
  // the group's calibrated `position` already absorbs the GLB's local-space
  // center offset (cx, cz) and floor offset (fy). Trying to place the badge
  // at local (0, height, 0) inside the group double-counts those offsets
  // AND interacts with the group's rotation, sending the badge sideways
  // and to the wrong height. World-space placement avoids that math.
  const [badgeWorldPos, setBadgeWorldPos] = useState<
    [number, number, number] | null
  >(null);
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);

  // Posture is driven by the layout (stand for the standing idle anchors,
  // sit for everything else — desks, lounge chairs, lobby, boardroom).
  // Pick the idle clip based on posture and let useLoader/FBX cache do
  // the work — same pattern as GuideCharacter (single idle URL, no
  // dual-clip switch). If posture flips, the URL changes and the hook
  // re-suspends with the cached FBX.
  const isStanding = layout.posture === "stand";
  const idleAnimUrl = isStanding
    ? standingIdleAnimFor(layout.modelUrl)
    : sittingIdleAnimFor(layout.modelUrl);

  // Working/talking are always seated (Typing + SittingTalking) — they
  // only happen at desks. Idle is the only state that can be sit OR
  // stand depending on where the agent ended up.
  const { model, mixer, idleClip, actionClip, talkClip } = useCharacterAssets({
    modelUrl: layout.modelUrl,
    idleAnimUrl,
    actionAnimUrl: TYPING_ANIM,
    talkAnimUrl: SITTING_TALKING_ANIM,
  });

  // Animation state machine — four named states crossfaded based on agent
  // status. Tracking via ref so we only crossfade on actual transitions,
  // not every status re-derive.
  //
  // - working: Typing (sit). Status=`working` only ever happens at a desk.
  // - talking / meeting: SittingTalking — same gesture clip; meeting just
  //   means the seat is in the boardroom (driven by layout, not by clip).
  // - idle: whichever clip got loaded via `idleAnimUrl` above (sit at a
  //   chair anchor, stand at a stand anchor).
  type AnimState = "idle" | "working" | "talking" | "meeting";
  const animStateRef = useRef<AnimState | null>(null);
  useEffect(() => {
    if (!idleClip && !actionClip && !talkClip) return;

    const target: AnimState =
      status === "working" && actionClip
        ? "working"
        : status === "talking" && talkClip
          ? "talking"
          : status === "meeting" && talkClip
            ? "meeting"
            : "idle";

    const clipFor = (s: AnimState): THREE.AnimationClip | null => {
      if (s === "working") return actionClip;
      if (s === "talking" || s === "meeting") return talkClip;
      return idleClip;
    };

    if (animStateRef.current === null) {
      const clip = clipFor(target);
      if (clip) mixer.clipAction(clip).reset().fadeIn(0.3).play();
      animStateRef.current = target;
      return;
    }

    if (animStateRef.current === target) return;

    const FADE = 0.25;
    const fromClip = clipFor(animStateRef.current);
    const toClip = clipFor(target);
    if (toClip) {
      const to = mixer.clipAction(toClip).reset();
      to.play();
      if (fromClip) mixer.clipAction(fromClip).crossFadeTo(to, FADE, true);
    }
    animStateRef.current = target;

    return () => {
      mixer.stopAllAction();
    };
  }, [status, mixer, idleClip, actionClip, talkClip]);

  // Re-calibrate whenever model or target changes
  useEffect(() => {
    calibrated.current = false;
    frameCount.current = 0;
    setVisible(false);
  }, [model, target.x, target.y, target.z]);

  useFrame((state, delta) => {
    if (!groupRef.current) return;

    // ── Calibration phase ──────────────────────────────────────────────
    // Wait two frames for the GLB to settle, then compute Hips anchor +
    // the badge world position. Mixer must update during this phase so
    // the bind-pose bone matrices propagate before we measure.
    if (!calibrated.current) {
      mixer.update(delta);

      if (frameCount.current < 2) {
        frameCount.current++;
        return;
      }

      const group = groupRef.current;
      group.position.set(0, 0, 0);
      group.updateWorldMatrix(true, true);

      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) return;

      // Anchor the Hips bone (X/Y/Z) to the workstation target. Seat
      // heights vary per chair, so use target.y as the desired Hips
      // world-Y instead of `target.y - bbox.min.y` (feet-on-floor) —
      // that put characters at the same absolute height regardless of
      // chair, which made CEO look sunk into a tall chair and CTO look
      // perched above a short one. With Hips-anchor, each workstation's
      // `y` in office-anchors.ts becomes the seat height of its chair.
      const hips = group.getObjectByName("Hips");
      const anchor = new THREE.Vector3();
      if (hips) {
        hips.getWorldPosition(anchor);
      } else {
        const fy = box.min.y;
        anchor.set(
          (box.min.x + box.max.x) / 2,
          fy,
          (box.min.z + box.max.z) / 2,
        );
      }

      const hipsOffset = isStanding ? STANDING_HIPS_OFFSET : SEATED_HIPS_OFFSET;
      group.position.set(
        target.x - anchor.x,
        target.y + hipsOffset - anchor.y,
        target.z - anchor.z,
      );
      group.updateWorldMatrix(true, true);
      calibrated.current = true;

      // One-shot state writes — useFrame stops touching React state for
      // visible/badgeWorldPos once calibrated.current flips.
      setBadgeWorldPos([
        target.x,
        target.y + hipsOffset + (box.max.y - anchor.y) + 0.35,
        target.z,
      ]);
      setVisible(true);
      return;
    }

    // ── Steady-state: throttle-only animation update ─────────────────
    // Character + badge are NEVER hidden by the optimizer — only the
    // mixer's tick rate scales down for distant agents. Visually identical
    // for the user (animation still plays smoothly at 20fps for back-row
    // characters), but ~3x cheaper on skinning matrix recompute.
    groupRef.current.getWorldPosition(_scratchPos);
    const distance = state.camera.position.distanceTo(_scratchPos);

    if (distance > NEAR_FULL_DISTANCE) {
      throttleCounter.current = (throttleCounter.current + 1) % THROTTLE_FRAMES;
      if (throttleCounter.current !== 0) return;
      mixer.update(delta * THROTTLE_FRAMES);
    } else {
      mixer.update(delta);
    }
  });

  // Hover cursor — only when click is wired up. Cleanup on unmount restores
  // the default cursor in case the user navigates away mid-hover.
  const interactive = !!onClick;
  useEffect(() => {
    if (interactive && hovered) {
      document.body.style.cursor = "pointer";
      return () => {
        document.body.style.cursor = "";
      };
    }
  }, [interactive, hovered]);

  const handlePointerOver = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!interactive) return;
      e.stopPropagation();
      setHovered(true);
    },
    [interactive],
  );

  const handlePointerOut = useCallback(() => {
    setHovered(false);
  }, []);

  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      if (!interactive) return;
      e.stopPropagation();
      onClick?.();
    },
    [interactive, onClick],
  );

  // Pre-`ready` agents render the model but show the neutral idle badge.
  // Once provisioning lands, we surface the live status.
  const effectiveStatus = ready ? status : "idle";
  const roleLabel = formatRoleLabel(role);

  return (
    <>
      <group
        ref={groupRef}
        rotation={[0, layout.rotationY, 0]}
        visible={visible}
        onClick={interactive ? handleClick : undefined}
        onPointerOver={interactive ? handlePointerOver : undefined}
        onPointerOut={interactive ? handlePointerOut : undefined}
      >
        <primitive object={model} />
      </group>
      {visible && badgeWorldPos && (
        <CharacterBadge
          role={roleLabel}
          status={statusLabelFor(effectiveStatus)}
          dotColor={dotColorFor(effectiveStatus)}
          position={badgeWorldPos}
        />
      )}
    </>
  );
}
