"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { CameraMode, RoleLayout } from "../types";
import {
  ONBOARDING_CAM_POS,
  ONBOARDING_CAM_TARGET,
  OVERVIEW_CAM_POS,
  OVERVIEW_CAM_TARGET,
  MEETING_DISTANCE,
  MEETING_HEIGHT,
  MEETING_TARGET_HEIGHT,
  LERP_ONBOARDING,
  LERP_ZOOM_OUT,
  LERP_FOLLOW,
  LERP_MEETING,
  FOLLOW_BACK,
  FOLLOW_HEIGHT,
  TOUR_FOLLOW_BACK,
  TOUR_FOLLOW_HEIGHT,
  TOUR_LERP_FOLLOW,
  TOUR_INTRO_DISTANCE,
  TOUR_INTRO_HEIGHT,
  TOUR_INTRO_LOOK_HEIGHT,
  LERP_TOUR_INTRO,
  GUIDE_POSITION,
  GUIDE_ROTATION_Y,
} from "../constants";

interface CameraControllerProps {
  mode:               CameraMode;
  /** Layout of the agent currently being focused — required when mode is
   *  "agent-focus". Camera position/target are computed from the agent's
   *  desk position + facing direction. */
  focusLayout?:       RoleLayout | null;
  /** When true (dev workstation focus), agent-focus mode uses an aerial
   *  framing — high above + behind the chair, looking down on the room.
   *  The default close meeting framing is for actual agent-meeting use. */
  focusAerial?:       boolean;
  onReady:            () => void;
  onZoomOutComplete:  () => void;
  guidePosRef:        React.RefObject<THREE.Vector3>;
  guideForwardRef:    React.RefObject<THREE.Vector3>;
}

// Aerial workstation framing — camera floats above-and-behind the chair,
// looking down at the desk so the user can see the chair in the context
// of the surrounding room. Tweak if the angle reads too steep / too flat.
const AERIAL_BACK_DISTANCE = 9;
const AERIAL_HEIGHT        = 13;
const AERIAL_LOOK_FORWARD  = 2;
const AERIAL_LOOK_HEIGHT   = 0.5;

export function CameraController({
  mode, focusLayout, focusAerial = false, onReady, onZoomOutComplete, guidePosRef, guideForwardRef,
}: CameraControllerProps) {
  const { camera }    = useThree();
  const readyFired    = useRef(false);
  const zoomDoneFired = useRef(false);
  const tmpTarget     = useMemo(() => new THREE.Vector3(), []);
  const tmpFollowPos  = useMemo(() => new THREE.Vector3(), []);
  const tmpFocusPos   = useMemo(() => new THREE.Vector3(), []);
  const tmpFocusLook  = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    if (mode === "onboarding") {
      zoomDoneFired.current = false;
      readyFired.current    = false;
    }
  }, [mode]);

  useFrame(() => {
    if (mode === "idle") return;

    if (mode === "tour-intro") {
      // Face-to-face framing at Jia's spawn — camera sits in front of her
      // (along her facing vector) at roughly eye level, looking back at
      // her head. Uses the GUIDE_* constants directly so this works
      // before the tour starts and the forward ref hasn't been written.
      // Jia's `forwardRef` convention is (-sin, -cos) which actually
      // points to her BACK (used by tour-follow for over-the-shoulder).
      // For face-to-face, sit on the opposite side: (+sin, +cos).
      const fx = Math.sin(GUIDE_ROTATION_Y);
      const fz = Math.cos(GUIDE_ROTATION_Y);
      tmpFollowPos.set(
        GUIDE_POSITION.x + fx * TOUR_INTRO_DISTANCE,
        GUIDE_POSITION.y + TOUR_INTRO_HEIGHT,
        GUIDE_POSITION.z + fz * TOUR_INTRO_DISTANCE,
      );
      camera.position.lerp(tmpFollowPos, LERP_TOUR_INTRO);
      tmpTarget.set(
        GUIDE_POSITION.x,
        GUIDE_POSITION.y + TOUR_INTRO_LOOK_HEIGHT,
        GUIDE_POSITION.z,
      );
      camera.lookAt(tmpTarget);
      return;
    }

    if (mode === "follow-guide" || mode === "tour-follow") {
      // Onboarding's `follow-guide` is the cinematic shot (further back,
      // higher up). Room tour's `tour-follow` is over-the-shoulder POV
      // (~1m behind, eye-level) so the user feels they're walking with
      // Jia rather than watching her from the rafters.
      const isTour = mode === "tour-follow";
      const dBack   = isTour ? TOUR_FOLLOW_BACK   : FOLLOW_BACK;
      const dHeight = isTour ? TOUR_FOLLOW_HEIGHT : FOLLOW_HEIGHT;
      const lerpAmt = isTour ? TOUR_LERP_FOLLOW   : LERP_FOLLOW;
      const back = guideForwardRef.current.clone().normalize().multiplyScalar(dBack);
      tmpFollowPos.copy(guidePosRef.current).add(back);
      tmpFollowPos.y += dHeight;
      camera.position.lerp(tmpFollowPos, lerpAmt);
      tmpTarget.copy(guidePosRef.current);
      tmpTarget.y += 1.6;
      camera.lookAt(tmpTarget);
      return;
    }

    if (mode === "agent-focus") {
      // Without a focus layout there's nothing to frame — bail out early
      // instead of snapping to (0,0,0). Caller should switch back to idle.
      if (!focusLayout) return;
      const { position, rotationY } = focusLayout;

      const fx = Math.sin(rotationY);
      const fz = Math.cos(rotationY);

      if (focusAerial) {
        // Behind-and-above framing for dev workstation inspection. Camera
        // sits behind the chair (opposite of facing) and high up, looking
        // down past the desk into the rest of the room.
        tmpFocusPos.set(
          position.x - fx * AERIAL_BACK_DISTANCE,
          position.y + AERIAL_HEIGHT,
          position.z - fz * AERIAL_BACK_DISTANCE,
        );
        tmpFocusLook.set(
          position.x + fx * AERIAL_LOOK_FORWARD,
          position.y + AERIAL_LOOK_HEIGHT,
          position.z + fz * AERIAL_LOOK_FORWARD,
        );
      } else {
        // Meeting framing — camera sits MEETING_DISTANCE in front of the
        // agent along their facing vector, then raised by MEETING_HEIGHT.
        tmpFocusPos.set(
          position.x + fx * MEETING_DISTANCE,
          position.y + MEETING_HEIGHT,
          position.z + fz * MEETING_DISTANCE,
        );
        tmpFocusLook.set(position.x, position.y + MEETING_TARGET_HEIGHT, position.z);
      }

      camera.position.lerp(tmpFocusPos, LERP_MEETING);
      camera.getWorldDirection(tmpTarget);
      tmpTarget.multiplyScalar(10).add(camera.position).lerp(tmpFocusLook, LERP_MEETING);
      camera.lookAt(tmpTarget);
      return;
    }

    // onboarding or zoom-out
    const targetPos  = mode === "onboarding" ? ONBOARDING_CAM_POS    : OVERVIEW_CAM_POS;
    const lookTarget = mode === "onboarding" ? ONBOARDING_CAM_TARGET  : OVERVIEW_CAM_TARGET;
    const lerp       = mode === "onboarding" ? LERP_ONBOARDING        : LERP_ZOOM_OUT;

    camera.position.lerp(targetPos, lerp);
    camera.getWorldDirection(tmpTarget);
    tmpTarget.multiplyScalar(10).add(camera.position).lerp(lookTarget, lerp);
    camera.lookAt(tmpTarget);

    if (mode === "onboarding") {
      if (!readyFired.current && camera.position.distanceTo(targetPos) < 1) {
        readyFired.current = true;
        onReady();
      }
    } else {
      if (!zoomDoneFired.current && camera.position.distanceTo(targetPos) < 0.5) {
        zoomDoneFired.current = true;
        onZoomOutComplete();
      }
    }
  });

  return null;
}
