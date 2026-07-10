import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ccxt ships optional protobuf deps the bundler can't resolve; load it from
  // node_modules at runtime instead of bundling (used by the embedded bot
  // engine via instrumentation.ts).
  serverExternalPackages: ["ccxt"],
};

export default nextConfig;
