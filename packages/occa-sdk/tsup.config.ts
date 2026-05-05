import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    pda: "src/pda.ts",
    constants: "src/constants.ts",
    derivation: "src/derivation.ts",
    instructions: "src/instructions.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  target: "es2020",
  // runtime deps stay external — the consumer's bundler resolves them.
  external: ["@solana/web3.js", "@noble/hashes"],
});
