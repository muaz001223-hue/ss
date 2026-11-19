import { randomBytes } from "node:crypto";
import { access, chmod, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");

if (process.env.RENDER) {
  console.log("Using Render environment configuration.");
} else try {
  await access(envPath, constants.F_OK);
  console.log("Using existing .env configuration.");
} catch {
  const dashboardToken = randomBytes(32).toString("base64url");
  const deviceToken = randomBytes(32).toString("base64url");
  const simulatorToken = randomBytes(32).toString("base64url");
  const deviceTokens = JSON.stringify({
    "robot-1": deviceToken,
    "sim-robot-1": simulatorToken,
  });
  const contents = [
    "HOST=127.0.0.1",
    "PORT=4100",
    "CORS_ORIGIN=http://localhost:3000",
    `DASHBOARD_TOKEN=${dashboardToken}`,
    `DEVICE_TOKEN=${deviceToken}`,
    `DEVICE_TOKENS_JSON=${deviceTokens}`,
    "SIM_ROBOT_ID=sim-robot-1",
    "",
  ].join("\n");

  await writeFile(envPath, contents, { flag: "wx", mode: 0o600 });
  await chmod(envPath, 0o600);
  console.log("Created private .env credentials. Read them from .env; keep the file private.");
}
