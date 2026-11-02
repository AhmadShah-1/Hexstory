import sharp from 'sharp';

/**
 * Decodes an image and re-encodes it as WebP: a full size (at most 1600 px) and a 160 px thumbnail.
 * Re-encoding strips EXIF/GPS metadata and rejects anything that isn't a real image. Used for
 * uploads and imports alike. Throws if the file can't be read as an image.
 */
export async function encodeImage(original: Buffer): Promise<{ full: Buffer; thumb: Buffer }> {
  const image = sharp(original, { limitInputPixels: 50_000_000 }).rotate();
  const full = await image.clone().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  const thumb = await image.clone().resize(160, 160, { fit: 'cover', position: 'attention' }).webp({ quality: 75 }).toBuffer();
  return { full, thumb };
}
