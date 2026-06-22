import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the dev server's HMR/dev resources from these hosts. The Electron shell and
  // local browsers may hit either localhost or 127.0.0.1; without this, Next 16 blocks
  // cross-origin dev resources and the client-side app breaks (dead tabs, no live data).
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};

export default nextConfig;
