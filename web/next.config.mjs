import nextEnv from "@next/env";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

nextEnv.loadEnvConfig(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  process.env.NODE_ENV === "development",
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  reactStrictMode: true,
  ...(process.env.NODE_ENV === "development" && {
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
  }),
};

export default nextConfig;
