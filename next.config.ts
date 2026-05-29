import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '500mb',
    },
  },
  // xlsx est une lib CommonJS qui ne peut pas être bundlée par Turbopack/webpack.
  // On la déclare external pour qu'elle soit chargée nativement par Node.js au runtime.
  serverExternalPackages: ['xlsx'],
};

export default nextConfig;
