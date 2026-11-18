import { access, cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve("public");
const exportDirectory = resolve("web/out");

try {
  await access(resolve(exportDirectory, "index.html"));
} catch {
  throw new Error("Next.js static export is missing web/out/index.html.");
}

await mkdir(outputDirectory, { recursive: true });
await cp(exportDirectory, outputDirectory, { recursive: true, force: true });
console.log("Prepared Vercel static output in public/.");
