"use client";

import { useCallback, useMemo } from "react";
import { useLoader } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";

// Plug-and-play character pipeline: loads a GLB rig + 3 FBX clips, clones
// the rig per-instance (so multiple characters don't share a mixer), and
// keeps animation track names that match an actual bone in the rig.
//
// Hard requirement: the FBX files MUST use the same bone naming as the
// GLB rig (the asset-pack convention: `Hips`, `Spine_01`, `Clavicle_L`,
// `Shoulder_L`, `Elbow_L`, `Hand_L`, …). Mixamo-rigged FBXes use a
// different vocabulary AND a different rest pose, so they don't drive
// this rig — retarget them in Blender first.

export interface UseCharacterAssetsOptions {
  modelUrl:      string;
  /** Played in idle states (idle, cooldown, connecting, etc). Caller
   *  picks the variant — sitting clip for chair anchors, standing clip
   *  for stand anchors — and the URL change re-suspends to the cached
   *  FBX without rebuilding the rig. */
  idleAnimUrl:   string;
  /** Played while status === "working". For standing characters typically
   *  walking-in-place; for seated characters typically Typing. */
  actionAnimUrl: string;
  /** Played while status === "talking". */
  talkAnimUrl:   string;
}

export interface CharacterAssets {
  model:      THREE.Group;
  mixer:      THREE.AnimationMixer;
  idleClip:   THREE.AnimationClip | null;
  /** Resolved from `actionAnimUrl` — semantic varies by caller (walk for
   *  guide, typing for agent). */
  actionClip: THREE.AnimationClip | null;
  talkClip:   THREE.AnimationClip | null;
}

export function useCharacterAssets(opts: UseCharacterAssetsOptions): CharacterAssets {
  const { scene } = useGLTF(opts.modelUrl);
  const idleFbx   = useLoader(FBXLoader, opts.idleAnimUrl);
  const actionFbx = useLoader(FBXLoader, opts.actionAnimUrl);
  const talkFbx   = useLoader(FBXLoader, opts.talkAnimUrl);

  const model = useMemo(() => {
    const clone = SkeletonUtils.clone(scene) as THREE.Group;
    clone.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) c.frustumCulled = false;
    });
    return clone;
  }, [scene]);

  const mixer = useMemo(() => new THREE.AnimationMixer(model), [model]);

  const boneNames = useMemo(() => {
    const s = new Set<string>();
    model.traverse((c) => s.add(c.name));
    return s;
  }, [model]);

  const filterClip = useCallback(
    (src: THREE.AnimationClip | undefined): THREE.AnimationClip | null => {
      if (!src) return null;
      const clip = src.clone();
      clip.tracks = clip.tracks.filter(
        (t) => t.name.endsWith(".quaternion") && boneNames.has(t.name.split(".")[0]),
      );
      return clip.tracks.length > 0 ? clip : null;
    },
    [boneNames],
  );

  const idleClip   = useMemo(() => filterClip(idleFbx.animations[0]),   [idleFbx,   filterClip]);
  const actionClip = useMemo(() => filterClip(actionFbx.animations[0]), [actionFbx, filterClip]);
  const talkClip   = useMemo(() => filterClip(talkFbx.animations[0]),   [talkFbx,   filterClip]);

  return { model, mixer, idleClip, actionClip, talkClip };
}
