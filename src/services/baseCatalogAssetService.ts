import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { GarmentImageAsset } from '../domain/ambientCapture.js';
import type { ClosetItem } from '../types.js';

export interface BaseCatalogAssetDirectories {
  publicDir: string;
  demo2ProductImageDir: string;
}

export async function buildBaseCatalogAssets(
  items: readonly ClosetItem[],
  directories: BaseCatalogAssetDirectories,
): Promise<Map<string, GarmentImageAsset>> {
  const assets = new Map<string, GarmentImageAsset>();
  await Promise.all(items.map(async (item) => {
    const storagePath = resolveBaseCatalogStoragePath(item.imageUrl, directories);
    if (!storagePath) return;
    try {
      const [bytes, metadata] = await Promise.all([fs.readFile(storagePath), sharp(storagePath).metadata()]);
      if (!metadata.width || !metadata.height) return;
      const mimeType: GarmentImageAsset['mimeType'] = /\.webp$/i.test(storagePath)
        ? 'image/webp'
        : /\.png$/i.test(storagePath) ? 'image/png' : 'image/jpeg';
      assets.set(item.id, {
        assetId: `base_catalog_${createHash('sha256').update(item.id).digest('hex').slice(0, 18)}`,
        ownerUserId: 'base_catalog',
        role: 'canonical_product',
        imageUrl: item.imageUrl,
        storagePath,
        closetItemId: item.id,
        width: metadata.width,
        height: metadata.height,
        mimeType,
        verificationStatus: 'not_required',
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        createdAt: new Date(0).toISOString(),
      });
    } catch {
      // Missing or unreadable fixture images are excluded from visual identity recall.
    }
  }));
  return assets;
}

export function resolveBaseCatalogStoragePath(
  imageUrl: string,
  directories: BaseCatalogAssetDirectories,
): string | undefined {
  let candidate: string | undefined;
  if (path.isAbsolute(imageUrl)) {
    candidate = path.resolve(imageUrl);
  } else if (imageUrl.startsWith('/agent-assets/')) {
    candidate = path.resolve(directories.publicDir, imageUrl.slice('/agent-assets/'.length));
  } else if (imageUrl.startsWith('/demo2-product-images/')) {
    candidate = path.resolve(
      directories.demo2ProductImageDir,
      imageUrl.slice('/demo2-product-images/'.length),
    );
  }

  if (!candidate) return undefined;
  const allowedDirectories = [directories.publicDir, directories.demo2ProductImageDir];
  return allowedDirectories.some((directory) => isWithin(directory, candidate))
    ? candidate
    : undefined;
}

function isWithin(baseDir: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}
