import { access, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/cesium/Build/Cesium");
const destination = resolve(root, "web/public/cesium");

try {
  await access(source);
} catch {
  throw new Error("Cesium assets are missing. Run npm install before starting the web app.");
}

await cp(source, destination, { recursive: true, force: true });
console.log("Prepared Cesium static assets.");
