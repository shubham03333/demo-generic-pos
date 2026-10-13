
import type { NextConfig } from "next";
import withPWA from "next-pwa";

const nextConfig: NextConfig = {
  /* config options here */
  "eslint": { "ignoreDuringBuilds": true },
  transpilePackages: [
    '@capacitor/core',
    '@capacitor/preferences',
    '@devlas/capacitor-thermal-printer',
  ],

  // Memory optimizations for development and production
  serverExternalPackages: ['mysql2'],

  // Webpack optimizations for memory management
  webpack: (config, { dev, isServer }) => {
    // Memory optimizations for both dev and production
    config.optimization = {
      ...config.optimization,
      splitChunks: {
        ...config.optimization.splitChunks,
        cacheGroups: {
          ...config.optimization.splitChunks?.cacheGroups,
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendors',
            chunks: 'all',
            priority: 10,
            enforce: true,
          },
          // Separate large libraries
          mysql2: {
            test: /[\\/]node_modules[\\/]mysql2[\\/]/,
            name: 'mysql2',
            chunks: 'all',
            priority: 20,
          },
          react: {
            test: /[\\/]node_modules[\\/]react[\\/]/,
            name: 'react',
            chunks: 'all',
            priority: 30,
          },
        },
      },
    };

    // Performance limits - increased for better memory handling
    config.performance = {
      ...config.performance,
      maxAssetSize: 2000000, // 2MB
      maxEntrypointSize: 2000000, // 2MB
      hints: dev ? false : 'warning', // Disable hints in dev to reduce memory usage
    };

    // Add memory monitoring in development
    if (dev && isServer) {
      config.plugins.push(
        new (class MemoryMonitorPlugin {
          apply(compiler: any) {
            compiler.hooks.done.tap('MemoryMonitor', () => {
              const memUsage = process.memoryUsage();
              const usedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
              const totalMB = Math.round(memUsage.heapTotal / 1024 / 1024);

              if (usedMB > 1500) { // Log when memory usage exceeds 1.5GB
                console.warn(`⚠️ High memory usage detected: ${usedMB}MB / ${totalMB}MB`);
              }
            });
          }
        })()
      );
    }

    return config;
  },
};

export default nextConfig;
