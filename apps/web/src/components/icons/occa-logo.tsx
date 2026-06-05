import type { SVGProps } from "react";

// OCCA wordmark — the cracked-O monogram with the satellite dot.
// Single-color via `currentColor` so it inherits whatever text color
// the parent sets (white/70 in the top menu bar, brand white in
// onboarding, etc.). Default rendered size mirrors a small chip-icon
// (16px square); pass `width`/`height` or Tailwind size classes via
// `className` to scale.
export function OccaLogo({
  width = 20,
  height = 20,
  ...props
}: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 750 768"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M110.196 114.507C191.207 32.088 300.215 -5.90822 407.036 0.743288C463.934 6.9424 535.038 33.1015 567.097 100.198C607.839 185.469 560.215 262.255 649.955 311.732C761.131 373.027 759.554 472.191 739.447 524.54C739.447 524.54 739.596 524.429 739.886 524.216C721.536 571.186 693.597 615.284 656.042 653.493C507.547 804.57 264.975 806.387 114.245 657.55C-36.4863 508.714 -38.2986 265.585 110.196 114.507ZM278.595 205.799C180.338 263.643 147.47 390.37 205.182 488.853C262.893 587.334 389.33 620.278 487.586 562.434C585.841 504.59 618.709 377.863 560.999 279.381C503.287 180.899 376.851 147.955 278.595 205.799Z"
        fill="currentColor"
      />
      <path
        d="M713.269 209.856C724.921 229.74 718.285 255.327 698.446 267.007C678.607 278.686 653.079 272.034 641.426 252.15C629.774 232.265 636.41 206.678 656.249 194.999C676.088 183.32 701.616 189.971 713.269 209.856Z"
        fill="currentColor"
      />
    </svg>
  );
}
