import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ion-icon": DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          name?: string;
          src?: string;
          size?: "small" | "large";
        },
        HTMLElement
      >;
    }
  }
}
