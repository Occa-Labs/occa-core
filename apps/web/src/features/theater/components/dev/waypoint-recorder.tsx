"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  GUIDE_POSITION,
  LERP_FOLLOW,
  TOUR_FOLLOW_BACK,
  TOUR_FOLLOW_HEIGHT,
} from "../../constants";

// Camera offset during recording. Matches the room-tour playback POV so
// what you frame while recording is what plays back — over-the-shoulder
// ~1m behind Jia at eye-level. The recorder's quaternion is built from
// `charYaw = atan2(forward.x, forward.z)` so Jia's local forward is
// world +Z when yaw is zero — a NEGATIVE Z places the camera behind.
const REC_CAM_OFFSET = new THREE.Vector3(0, TOUR_FOLLOW_HEIGHT, -TOUR_FOLLOW_BACK);
// Look at Jia's chest (~1.6m above floor), same target Y as the playback
// follow camera so the framing stays identical between record + play.
const REC_LOOK_HEIGHT = 1.6;

// While the user holds no movement keys we still want the timeline to
// advance, so a heartbeat sample at the same position+rotation lands
// every IDLE_HEARTBEAT_MS. Each heartbeat tells the playback "another
// 500ms of holding here" — that's how recorded "stand and look around"
// pauses get replayed at their original duration.
const IDLE_HEARTBEAT_MS = 500;

export function WaypointRecorder({
  manualPosRef,
  forwardRef,
  onWalkingChange,
  onMarkerCount,
  onRecorded,
}: {
  manualPosRef:    React.RefObject<THREE.Vector3>;
  forwardRef:      React.RefObject<THREE.Vector3>;
  onWalkingChange?: (walking: boolean) => void;
  /** Bumped every time the SPACE marker hotkey fires, so the HUD can
   *  show the user the press registered. */
  onMarkerCount?:  (count: number) => void;
  onRecorded?:      (code: string)    => void;
}) {
  const { camera } = useThree();
  const keys       = useRef({ up: false, down: false, left: false, right: false });
  // Sample format: position + body facing at the moment we sampled, so
  // playback can replay "stand still and turn around" pauses verbatim.
  // `dialog` is set when the user pressed the marker hotkey at this
  // sample — gets emitted as a `dialog: "..."` placeholder in the code
  // block, then the user fills in the line manually.
  const recorded   = useRef<
    { x: number; z: number; rotationY: number; t: number; dialog?: string }[]
  >([]);
  // Wall-clock when recording started — every sample's `t` is relative
  // to this so playback can replay the exact pacing of the recording
  // (idle pauses, slow turns, look-around delays).
  const recordingStartRef = useRef(0);
  const walkingRef = useRef(false);
  const tmpUp      = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const tmpYaw     = useMemo(() => new THREE.Quaternion(),      []);
  const tmpOffset  = useMemo(() => new THREE.Vector3(),         []);
  const tmpLookAt  = useMemo(() => new THREE.Vector3(),         []);
  const charYaw    = useRef(0);
  // Keep the latest callbacks accessible from the keydown handler,
  // which is registered once on mount (empty deps).
  const onMarkerCountRef = useRef(onMarkerCount);
  onMarkerCountRef.current = onMarkerCount;

  // Seed yaw from Jia's current facing direction
  useEffect(() => {
    const { x: fx, z: fz } = forwardRef.current;
    const seed = Math.abs(fx) + Math.abs(fz) > 0.01 ? Math.atan2(fx, fz) : 0;
    charYaw.current = seed;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), seed);
    camera.position.copy(REC_CAM_OFFSET.clone().applyQuaternion(q).add(manualPosRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed first waypoint; emit recorded path on unmount
  useEffect(() => {
    recordingStartRef.current = performance.now();
    recorded.current.push({
      x: manualPosRef.current.x,
      z: manualPosRef.current.z,
      rotationY: charYaw.current,
      t: 0,
    });
    return () => {
      if (recorded.current.length < 2) return;
      const lines = recorded.current
        .map((p) => {
          const base = `position: new THREE.Vector3(${p.x.toFixed(2)}, 0, ${p.z.toFixed(2)}), rotationY: ${p.rotationY.toFixed(3)}, t: ${Math.round(p.t)}`;
          // Markers emit a placeholder string the user replaces by hand;
          // capitalised TODO so it's easy to grep + jump to.
          const dialog = p.dialog ? `, dialog: ${JSON.stringify(p.dialog)}` : "";
          return `  { ${base}${dialog} },`;
        })
        .join("\n");
      onRecorded?.(`const WAYPOINTS: readonly Waypoint[] = [\n${lines}\n];`);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp")    { keys.current.up    = true; e.preventDefault(); }
      if (e.key === "ArrowDown")  { keys.current.down  = true; e.preventDefault(); }
      if (e.key === "ArrowLeft")  { keys.current.left  = true; e.preventDefault(); }
      if (e.key === "ArrowRight") { keys.current.right = true; e.preventDefault(); }
      // Marker hotkey — drop a waypoint with a `dialog` placeholder at
      // Jia's current position + facing. Used to flag spots where Jia
      // should narrate during the room tour. Accept both `code === Space`
      // and `key === " "` so layouts that map Space to a non-`Space`
      // code still trigger.
      if ((e.code === "Space" || e.key === " ") && !e.repeat) {
        e.preventDefault();
        recorded.current.push({
          x: manualPosRef.current.x,
          z: manualPosRef.current.z,
          rotationY: charYaw.current,
          t: performance.now() - recordingStartRef.current,
          dialog: "TODO: dialog text here",
        });
        const count = recorded.current.filter((r) => r.dialog).length;
        onMarkerCountRef.current?.(count);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp")    keys.current.up    = false;
      if (e.key === "ArrowDown")  keys.current.down  = false;
      if (e.key === "ArrowLeft")  keys.current.left  = false;
      if (e.key === "ArrowRight") keys.current.right = false;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup",   onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup",   onUp);
    };
  }, []);

  useFrame((_, delta) => {
    const k          = keys.current;
    const TURN_SPEED = 2.2;
    const MOVE_SPEED = 1.8;
    // Walk sample density. Shorter = more waypoints, finer playback
    // fidelity for short moves. 0.6m roughly maps to one stride.
    const SAMPLE_DIST = 0.6;
    // Turn-in-place sample threshold (radians). When the recorder is
    // standing still and the user racks up >TURN_SAMPLE_RAD of rotation
    // since the last sample, we emit a new waypoint at the same xz with
    // the new rotationY — that's how "stop and look around" plays back.
    const TURN_SAMPLE_RAD = 0.3;

    if (k.left)  charYaw.current += TURN_SPEED * delta;
    if (k.right) charYaw.current -= TURN_SPEED * delta;

    const fx = Math.sin(charYaw.current);
    const fz = Math.cos(charYaw.current);
    forwardRef.current.set(fx, 0, fz);

    if (k.up)   { manualPosRef.current.x += fx * MOVE_SPEED * delta; manualPosRef.current.z += fz * MOVE_SPEED * delta; }
    if (k.down) { manualPosRef.current.x -= fx * MOVE_SPEED * delta; manualPosRef.current.z -= fz * MOVE_SPEED * delta; }

    const nowWalking = k.up || k.down;
    if (nowWalking !== walkingRef.current) {
      walkingRef.current = nowWalking;
      onWalkingChange?.(nowWalking);
      // On the walk → stop transition, push a final waypoint at the
      // current position even if the user didn't quite cover one
      // SAMPLE_DIST since the last sample. Without this, short walks
      // (<SAMPLE_DIST) are invisible to the playback — Jia just
      // rotates in place because no intermediate position was logged.
      if (!nowWalking) {
        const last = recorded.current[recorded.current.length - 1];
        if (last) {
          const dx = manualPosRef.current.x - last.x;
          const dz = manualPosRef.current.z - last.z;
          if (dx * dx + dz * dz > 0.01) {
            recorded.current.push({
              x: manualPosRef.current.x,
              z: manualPosRef.current.z,
              rotationY: charYaw.current,
              t: performance.now() - recordingStartRef.current,
            });
          }
        }
      }
    }

    // Guard for the first frame after mount: the seed `useEffect` runs
    // after the first React commit, but R3F's frameloop can already
    // fire one tick before that commit, leaving `recorded.current`
    // empty here. Skip until the seed lands.
    const last = recorded.current[recorded.current.length - 1];
    if (!last) return;
    const tNow = performance.now() - recordingStartRef.current;
    if (nowWalking) {
      const dx = manualPosRef.current.x - last.x;
      const dz = manualPosRef.current.z - last.z;
      if (dx * dx + dz * dz >= SAMPLE_DIST * SAMPLE_DIST) {
        recorded.current.push({
          x: manualPosRef.current.x,
          z: manualPosRef.current.z,
          rotationY: charYaw.current,
          t: tNow,
        });
      }
    } else if (k.left || k.right) {
      // Turn-in-place: position unchanged but yaw is. Sample once the
      // rotation delta crosses the threshold so that a long pivot turns
      // into one waypoint per ~17° step.
      let dyaw = charYaw.current - last.rotationY;
      if (dyaw >  Math.PI) dyaw -= 2 * Math.PI;
      if (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      if (Math.abs(dyaw) >= TURN_SAMPLE_RAD) {
        recorded.current.push({
          x: manualPosRef.current.x,
          z: manualPosRef.current.z,
          rotationY: charYaw.current,
          t: tNow,
        });
      }
    } else if (tNow - last.t >= IDLE_HEARTBEAT_MS) {
      // Pure idle (no input). Drop a heartbeat sample at the same pos
      // + rotation so the playback timeline knows time is passing here
      // and waits accordingly. Without this, "stand still and stare"
      // moments would be invisible to the player.
      recorded.current.push({
        x: manualPosRef.current.x,
        z: manualPosRef.current.z,
        rotationY: charYaw.current,
        t: tNow,
      });
    }

    // Match the room-tour playback camera exactly: snap yaw to the
    // current character facing (no smooth trail) and use the same
    // LERP_FOLLOW position-lerp factor that CameraController applies in
    // `tour-follow` mode. Earlier the recorder smoothly trailed yaw and
    // lerped 0.15, which made what you framed during recording look
    // slightly different from playback during turns.
    tmpYaw.setFromAxisAngle(tmpUp, charYaw.current);
    tmpOffset.copy(REC_CAM_OFFSET).applyQuaternion(tmpYaw).add(manualPosRef.current);
    camera.position.lerp(tmpOffset, LERP_FOLLOW);
    tmpLookAt.set(
      manualPosRef.current.x,
      GUIDE_POSITION.y + REC_LOOK_HEIGHT,
      manualPosRef.current.z,
    );
    camera.lookAt(tmpLookAt);
  });

  return null;
}
