import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const publicDir = path.join(root, "public");
const size = 1024;

const render = async (name, svg) => {
  const file = path.join(publicDir, name);
  await mkdir(publicDir, { recursive: true });
  await writeFile(file, await sharp(Buffer.from(svg)).png().toBuffer());
  console.log(`Generated ${file}`);
};

const optionA = `
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" rx="224" fill="#101014"/>
  <rect x="108" y="108" width="808" height="808" rx="190" fill="#18181D" stroke="#2E2E36" stroke-width="18"/>
  <rect x="224" y="224" width="576" height="576" rx="144" fill="#202027" stroke="#383842" stroke-width="10"/>
  <circle cx="412" cy="628" r="104" fill="#FF3448"/>
  <rect x="504" y="316" width="72" height="318" rx="36" fill="#FF3448"/>
  <path d="M541 322L714 286V366L541 402V322Z" fill="#FF3448"/>
  <path d="M627 615H745L705 575L755 525L880 650L755 775L705 725L745 685H627V615Z" fill="#FF3448"/>
  <path d="M627 615H745L705 575L755 525L880 650L755 775L705 725L745 685H627V615Z" fill="#FF3448"/>
</svg>`;

const optionB = `
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" rx="224" fill="#111116"/>
  <rect x="112" y="112" width="800" height="800" rx="188" fill="#1B1B20" stroke="#313139" stroke-width="16"/>
  <path d="M338 302H608C683 302 744 363 744 438V586C744 661 683 722 608 722H338C263 722 202 661 202 586V438C202 363 263 302 338 302Z" fill="#222228" stroke="#3A3A43" stroke-width="10"/>
  <path d="M516 372V568C516 633 467 678 401 678C342 678 296 642 296 594C296 542 350 505 414 514C432 516 449 522 465 531V426L626 392V465L516 488V372Z" fill="#FF3448"/>
  <rect x="618" y="486" width="182" height="74" rx="37" fill="#17171C"/>
  <path d="M664 504H743L719 480L762 437L859 534L762 631L719 588L743 564H664V504Z" fill="#FF3448"/>
</svg>`;

await render("app-icon-option-a.png", optionA);
await render("app-icon-option-b.png", optionB);
