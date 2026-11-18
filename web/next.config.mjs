import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const controlServerUrl =
      process.env.CONTROL_SERVER_PROXY_URL ?? "http://127.0.0.1:4100";

    return [
      {
        source: "/control-socket.io/:path*",
        destination: `${controlServerUrl}/socket.io/`,
      },
    ];
  },
};

export default nextConfig;
