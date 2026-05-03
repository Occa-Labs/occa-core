import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  transpilePackages: ["@occa/shared"],
  devIndicators: false,
};

export default nextConfig;
