import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const sourcePath = path.join(root, "assets", "app-icon-source.png");
const outPath = path.join(root, "src-tauri", "icons", "app-icon-source.png");
const size = 1024;
const visualSize = 900;

const icon = await sharp({
  create: {
    width: size,
    height: size,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([
    {
      input: await sharp(sourcePath)
        .resize(visualSize, visualSize, { fit: "contain" })
        .png()
        .toBuffer(),
      left: Math.round((size - visualSize) / 2),
      top: Math.round((size - visualSize) / 2),
    },
  ])
  .png()
  .toBuffer();

await writeFile(outPath, icon);
await copyFile(outPath, path.join(root, "public", "app-icon.png"));
console.log(`Generated ${outPath}`);
