/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['three'],
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config) => {
    config.externals = config.externals || [];
    return config;
  },
};

module.exports = nextConfig;
