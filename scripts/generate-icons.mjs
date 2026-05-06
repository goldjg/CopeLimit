import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const iconsDir = path.join(root, 'public', 'icons');
const sourceIconPath = path.join(root, '32B68FCA-EE7F-464A-A166-5D2A48363E3A.png');

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
      .resize(job.size, job.size, { fit: 'cover', position: 'centre' })
      .png()
      .toFile(outputPath);
    console.log(`generated ${job.output}`);
  } catch (error) {
    console.error(`failed generating ${job.output} from ${sourceIconPath}`);
    throw error;
  }
}
