/**
 * @file scripts/generate-icons.mjs
 *
 * Generates all PWA icon sizes from a single high-resolution source image.
 *
 * @description
 * Reads `app-icon-source.png` from the repository root and produces the
 * following output files in `public/icons/`:
 *
 * | File                    | Size (px) | Usage                                    |
 * |-------------------------|-----------|------------------------------------------|
 * | `icon-16.png`           | 16×16     | Browser favicon (small)                  |
 * | `icon-32.png`           | 32×32     | Browser favicon (standard)               |
 * | `icon-180.png`          | 180×180   | Apple touch icon (`apple-touch-icon`)    |
 * | `icon-192.png`          | 192×192   | PWA manifest (`any` purpose)             |
 * | `icon-512.png`          | 512×512   | PWA manifest (`any` purpose, large)      |
 * | `icon-512-maskable.png` | 512×512   | PWA manifest (`maskable` purpose)        |
 *
 * Images are cropped to a square with `cover` fit and centred to ensure
 * consistent app-icon framing across all required aspect ratios.
 *
 * ## Usage
 * ```sh
 * node scripts/generate-icons.mjs
 * ```
 *
 * Requires the `sharp` package (`npm install sharp`).
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const iconsDir = path.join(root, 'public', 'icons');
// Canonical source icon provided at repository root.
const sourceIconPath = path.join(root, 'app-icon-source.png');

const jobs = [
  { output: 'icon-16.png', size: 16 },
  { output: 'icon-32.png', size: 32 },
  { output: 'icon-180.png', size: 180 },
  { output: 'icon-192.png', size: 192 },
  { output: 'icon-512.png', size: 512 },
  { output: 'icon-512-maskable.png', size: 512 }
];

await mkdir(iconsDir, { recursive: true });

for (const job of jobs) {
  const outputPath = path.join(iconsDir, job.output);
  try {
    await sharp(sourceIconPath)
      // Intentionally crops to square to produce required app-icon aspect ratios.
      .resize(job.size, job.size, { fit: 'cover', position: 'centre' })
      .png()
      .toFile(outputPath);
    console.log(`generated ${job.output}`);
  } catch (error) {
    console.error(`failed generating ${job.output} from ${sourceIconPath}`);
    throw error;
  }
}
