"use client";

import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { SceneBounds } from "../types";
import { createResearchDashboardTexture } from "./screen-textures";

// Stock Demo.glb ships Facebook-style social UI on `Material_Screen_03`.
// Disabled for now — the CanvasTexture swap was costing more frame time
// than the visual swap was worth. Re-enable by adding the entry back:
//   PolygonOffice_Material_Screen_03: createResearchDashboardTexture,
const SCREEN_OVERRIDES: Record<string, () => THREE.Texture> = {};

interface OfficeModelProps {
  /** When true, roof + ceiling stay visible (closed-building look used
   *  by the public /demo route). When false (default), they're hidden so
   *  the top-down OS camera can see agents inside the cutaway view. */
  showRoof?: boolean;
}

export function OfficeModel({ showRoof = false }: OfficeModelProps) {
  const { scene } = useGLTF("/models/Demo.glb");
  useEffect(() => {
    scene.traverse((child) => {
      const name = child.name.toLowerCase();
      if (name.includes("roof") || name.includes("ceiling")) {
        child.visible = showRoof;
      }
    });

    // Swap in custom screen textures. Replace the entire material with a
    // MeshBasicMaterial bound to our canvas — that skips lighting math
    // entirely so the screen reads exactly like the canvas, without the
    // original emissive/PBR layering swallowing our texture.
    //
    // useGLTF returns a singleton scene cached at the app level, so this
    // effect can fire again on HMR / StrictMode remount with mesh.material
    // already pointing at our previous swap. The `userData.swapped` flag
    // makes the swap idempotent — second pass is a no-op, no leak.
    scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const replaceMat = (origMat: THREE.Material): THREE.Material => {
        if (origMat.userData?.swapped) return origMat;
        const factory = SCREEN_OVERRIDES[origMat.name];
        if (!factory) return origMat;
        const next = new THREE.MeshBasicMaterial({
          map: factory(),
          toneMapped: false,
        });
        next.name = origMat.name;
        next.userData.swapped = true;
        return next;
      };
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map(replaceMat);
      } else {
        mesh.material = replaceMat(mesh.material);
      }
    });
  }, [scene, showRoof]);
  return <primitive object={scene} />;
}

export function SceneReady({ onReady }: { onReady: () => void }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    // Suspense resolves once GLB/FBX promises settle, but Three.js still
    // compiles shaders + uploads textures lazily on first render. If we
    // signal ready right away the spinner hides into a frozen frame.
    // gl.compile walks the scene and forces both up-front so the next
    // frame paints clean.
    gl.compile(scene, camera);
    const id = requestAnimationFrame(() => onReady());
    return () => cancelAnimationFrame(id);
  }, [gl, scene, camera, onReady]);
  return null;
}

export function SceneBoundsScanner({ onBounds }: { onBounds: (b: SceneBounds, img: string) => void }) {
  const { scene, gl } = useThree();
  const scanned = useRef(false);

  useEffect(() => {
    if (scanned.current) return;
    const t = setTimeout(() => {
      scene.updateMatrixWorld(true);

      const box = new THREE.Box3();
      scene.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const mesh = child as THREE.Mesh;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const mb = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
        box.union(mb);
      });
      if (box.isEmpty()) return;

      scanned.current = true;
      const PAD = 2;
      const bounds: SceneBounds = [
        Math.floor(box.min.x - PAD), Math.floor(box.min.z - PAD),
        Math.ceil(box.max.x + PAD),  Math.ceil(box.max.z + PAD),
      ];

      const W = bounds[2] - bounds[0];
      const D = bounds[3] - bounds[1];
      const aspect = W / D;
      const RES = 1024;
      const rtW = aspect >= 1 ? RES : Math.round(RES * aspect);
      const rtH = aspect >= 1 ? Math.round(RES / aspect) : RES;

      const cx = (bounds[0] + bounds[2]) / 2;
      const cz = (bounds[1] + bounds[3]) / 2;
      const ortho = new THREE.OrthographicCamera(-W/2, W/2, D/2, -D/2, 0.1, box.max.y + 50);
      ortho.position.set(cx, box.max.y + 20, cz);
      ortho.up.set(0, 0, -1);
      ortho.lookAt(cx, 0, cz);
      ortho.updateProjectionMatrix();
      ortho.updateMatrixWorld(true);

      const rt = new THREE.WebGLRenderTarget(rtW, rtH);
      const prevTarget = gl.getRenderTarget();
      const bgColor = new THREE.Color();
      gl.getClearColor(bgColor);
      const bgAlpha = gl.getClearAlpha();

      gl.setRenderTarget(rt);
      gl.setClearColor(0x202226, 1);
      gl.clear();
      gl.render(scene, ortho);

      const pixels = new Uint8Array(rtW * rtH * 4);
      gl.readRenderTargetPixels(rt, 0, 0, rtW, rtH, pixels);
      gl.setRenderTarget(prevTarget);
      gl.setClearColor(bgColor, bgAlpha);
      rt.dispose();

      const canvas = document.createElement("canvas");
      canvas.width = rtW; canvas.height = rtH;
      const ctx = canvas.getContext("2d")!;
      const imgData = ctx.createImageData(rtW, rtH);
      for (let y = 0; y < rtH; y++) {
        const src = (rtH - 1 - y) * rtW * 4;
        imgData.data.set(pixels.subarray(src, src + rtW * 4), y * rtW * 4);
      }
      ctx.putImageData(imgData, 0, 0);

      onBounds(bounds, canvas.toDataURL("image/png"));
    }, 1200);
    return () => clearTimeout(t);
  }, [scene, gl, onBounds]);

  return null;
}
