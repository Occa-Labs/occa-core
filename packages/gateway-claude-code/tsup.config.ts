import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // Types-only contract for HTTP clients (the OCCA adapter import-types this).
    wire: "src/wire.ts",
    // Executable — tsup preserves the shebang from the source file.
    bin: "src/bin.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  target: "node18",
  // Node builtins only — nothing to bundle, nothing external to declare.
});
