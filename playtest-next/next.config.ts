import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Node-only packages used by the API (system metrics, QR codes, multipart uploads): load them with Node's own
  // require instead of bundling them.
  serverExternalPackages: ['systeminformation', 'qrcode', 'busboy'],
  turbopack: {
    // This app sits inside the old repo (which has its own package-lock.json): don't treat the repo as the root.
    root: path.resolve(__dirname),
    ignoreIssue: [
      // The API starts adb / emulator / sdkmanager / flutter and reads SDK folders chosen at runtime — on purpose.
      // That only matters for file tracing on serverless hosts; PlayTest runs on your own PC.
      { path: '**/src/server/**', title: /Dynamic filesystem access/ },
    ],
  },
  // Large pages (Developer, Device Manager) import many Chakra components and icons: tree-shake those imports.
  experimental: {
    optimizePackageImports: ['@chakra-ui/react', 'react-icons/lu', 'react-icons/si'],
  },
};

export default nextConfig;
