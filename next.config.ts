import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["falkordb", "@huggingface/transformers"],
};

export default nextConfig;
