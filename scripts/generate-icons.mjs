import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const iconsDir = path.join(root, 'public', 'icons');

const jobs = [
  { input: 'icon.svg', output: 'icon-16.png', size: 16 },
  { input: 'icon.svg', output: 'icon-32.png', size: 32 },
  { input: 'icon.svg', output: 'icon-180.png', size: 180 },
  { input: 'icon.svg', output: 'icon-192.png', size: 192 },
  { input: 'icon.svg', output: 'icon-512.png', size: 512 },
  { input: 'icon-maskable.svg', output: 'icon-512-maskable.png', size: 512 }
];

await mkdir(iconsDir, { recursive: true });

for (const job of jobs) {
  const inputPath = path.join(iconsDir, job.input);
  const outputPath = path.join(iconsDir, job.output);
  await sharp(inputPath)
    .resize(job.size, job.size)
    .png()
    .toFile(outputPath);
  console.log(`generated ${job.output}`);
}
