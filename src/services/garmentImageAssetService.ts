import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type {
  AmbientGarmentSlot,
  GarmentImageAsset,
  NormalizedBoundingBox,
} from '../domain/ambientCapture.js';
import { makeId } from '../utils/ids.js';

export interface GarmentCropInput {
  userId: string;
  sourceFramePath: string;
  sourceFrameId: string;
  observationItemId: string;
  boundingBox: NormalizedBoundingBox;
  slot: AmbientGarmentSlot;
  capturedAt?: string;
}

export interface GarmentCropResult {
  asset: GarmentImageAsset;
  cropPath: string;
}

export interface GarmentCropQuality {
  result: 'pass' | 'fail' | 'uncertain';
  garmentVisible: boolean;
  bodyDominance: 'low' | 'medium' | 'high';
  confidence: number;
  issues: string[];
}

const MIN_CROP_WIDTH = 160;
const MIN_CROP_HEIGHT = 160;
const MIN_CROP_PIXELS = 40_000;

export class GarmentImageAssetService {
  constructor(
    private readonly options: {
      rootDirectory: string;
      jpegQuality?: number;
      maxDimension?: number;
      marginRatio?: number;
    },
  ) {}

  async storeEvidence(input: {
    userId: string;
    sourceFramePath: string;
    sourceFrameId: string;
    capturedAt?: string;
  }): Promise<GarmentImageAsset> {
    const metadata = await sharp(input.sourceFramePath).metadata();
    if (!metadata.width || !metadata.height) throw new Error('CAPTURE_EVIDENCE_NOT_DECODABLE');
    const bytes = await sharp(input.sourceFramePath)
      .rotate()
      .resize({
        width: this.options.maxDimension ?? 1800,
        height: this.options.maxDimension ?? 1800,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: this.options.jpegQuality ?? 84, mozjpeg: true })
      .toBuffer();
    return this.writeAsset({
      userId: input.userId,
      role: 'capture_evidence',
      prefix: 'evidence',
      bytes,
      sourceFrameId: input.sourceFrameId,
      verificationStatus: 'not_required',
      createdAt: input.capturedAt,
    });
  }

  async cropGarment(input: GarmentCropInput): Promise<GarmentCropResult> {
    assertBoundingBox(input.boundingBox);
    const oriented = await sharp(input.sourceFramePath, { failOn: 'error' })
      .rotate()
      .toBuffer({ resolveWithObject: true });
    if (!oriented.info.width || !oriented.info.height) throw new Error('GARMENT_SOURCE_NOT_DECODABLE');
    const crop = cropPixels(
      input.boundingBox,
      oriented.info.width,
      oriented.info.height,
      input.slot,
      this.options.marginRatio ?? 0.08,
    );
    if (crop.width < MIN_CROP_WIDTH || crop.height < MIN_CROP_HEIGHT || crop.width * crop.height < MIN_CROP_PIXELS) {
      throw new Error('GARMENT_CROP_TOO_SMALL');
    }
    const bytes = await sharp(oriented.data, { failOn: 'error' })
      .extract(crop)
      .resize({
        width: this.options.maxDimension ?? 1200,
        height: this.options.maxDimension ?? 1200,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: this.options.jpegQuality ?? 88, mozjpeg: true })
      .toBuffer();
    const quality = await deterministicCropQuality(bytes);
    if (quality.result !== 'pass') throw new Error(`GARMENT_CROP_QUALITY_${quality.issues[0] ?? 'FAILED'}`);
    const asset = await this.writeAsset({
      userId: input.userId,
      role: 'garment_appearance',
      prefix: 'appearance',
      bytes,
      sourceFrameId: input.sourceFrameId,
      observationItemId: input.observationItemId,
      verificationStatus: 'not_required',
      createdAt: input.capturedAt,
    });
    return { asset, cropPath: asset.storagePath! };
  }

  async storeProductImage(input: {
    userId: string;
    sourceAsset: GarmentImageAsset;
    closetItemId: string;
    bytes: Buffer;
    mimeType?: 'image/jpeg' | 'image/png' | 'image/webp';
    createdAt?: string;
  }): Promise<GarmentImageAsset> {
    const normalized = await sharp(input.bytes, { failOn: 'error' })
      .rotate()
      .resize({ width: 1024, height: 1024, fit: 'contain', background: '#f7f7f4' })
      .webp({ quality: 90 })
      .toBuffer();
    return this.writeAsset({
      userId: input.userId,
      role: 'canonical_product',
      prefix: 'product',
      bytes: normalized,
      sourceAssetId: input.sourceAsset.assetId,
      sourceFrameId: input.sourceAsset.sourceFrameId,
      observationItemId: input.sourceAsset.observationItemId,
      closetItemId: input.closetItemId,
      verificationStatus: 'pending',
      createdAt: input.createdAt,
      mimeType: 'image/webp',
    });
  }

  async deleteAssets(assets: GarmentImageAsset[]): Promise<void> {
    await Promise.all(assets.map(async (asset) => {
      if (!asset.storagePath || !isWithin(this.options.rootDirectory, asset.storagePath)) return;
      await fs.unlink(asset.storagePath).catch(() => undefined);
    }));
  }

  private async writeAsset(input: {
    userId: string;
    role: GarmentImageAsset['role'];
    prefix: string;
    bytes: Buffer;
    sourceAssetId?: string;
    sourceFrameId?: string;
    observationItemId?: string;
    closetItemId?: string;
    verificationStatus: GarmentImageAsset['verificationStatus'];
    createdAt?: string;
    mimeType?: GarmentImageAsset['mimeType'];
  }): Promise<GarmentImageAsset> {
    const assetId = makeId(`wardrobe_${input.prefix}`);
    const userDirectory = path.join(this.options.rootDirectory, 'users', userKey(input.userId), 'assets');
    await fs.mkdir(userDirectory, { recursive: true });
    const mimeType = input.mimeType ?? 'image/jpeg';
    const extension = mimeType === 'image/webp' ? 'webp' : mimeType === 'image/png' ? 'png' : 'jpg';
    const storagePath = path.join(userDirectory, `${input.prefix}_${assetId}.${extension}`);
    await fs.writeFile(storagePath, input.bytes, { flag: 'wx' });
    const metadata = await sharp(input.bytes).metadata();
    if (!metadata.width || !metadata.height) {
      await fs.unlink(storagePath).catch(() => undefined);
      throw new Error('GARMENT_ASSET_NOT_DECODABLE');
    }
    return {
      assetId,
      ownerUserId: input.userId,
      role: input.role,
      imageUrl: `/api/fashion/wardrobe-assets/${encodeURIComponent(assetId)}`,
      storagePath,
      sourceAssetId: input.sourceAssetId,
      sourceFrameId: input.sourceFrameId,
      observationItemId: input.observationItemId,
      closetItemId: input.closetItemId,
      width: metadata.width,
      height: metadata.height,
      mimeType,
      verificationStatus: input.verificationStatus,
      contentHash: createHash('sha256').update(input.bytes).digest('hex'),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
  }
}

export async function deterministicCropQuality(bytes: Buffer): Promise<GarmentCropQuality> {
  try {
    const image = sharp(bytes, { failOn: 'error' });
    const [metadata, stats] = await Promise.all([image.metadata(), image.stats()]);
    const issues: string[] = [];
    if (!metadata.width || !metadata.height) issues.push('NOT_DECODABLE');
    if ((metadata.width ?? 0) < MIN_CROP_WIDTH || (metadata.height ?? 0) < MIN_CROP_HEIGHT) issues.push('TOO_SMALL');
    if ((metadata.width ?? 0) * (metadata.height ?? 0) < MIN_CROP_PIXELS) issues.push('PIXEL_AREA_TOO_SMALL');
    const averageDeviation = stats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.stdev, 0) / Math.max(1, Math.min(3, stats.channels.length));
    if (averageDeviation < 2.2) issues.push('NEAR_BLANK');
    if (stats.sharpness < 0.12) issues.push('COMPLETELY_BLURRED');
    return {
      result: issues.length ? 'fail' : 'pass',
      garmentVisible: issues.length === 0,
      bodyDominance: 'medium',
      confidence: issues.length ? 0 : Math.min(1, 0.75 + Math.min(stats.sharpness, 1) * 0.25),
      issues,
    };
  } catch {
    return { result: 'fail', garmentVisible: false, bodyDominance: 'high', confidence: 0, issues: ['NOT_DECODABLE'] };
  }
}

function assertBoundingBox(box: NormalizedBoundingBox): void {
  const values = [box.x, box.y, box.width, box.height];
  if (values.some((value) => !Number.isFinite(value))) throw new Error('GARMENT_BBOX_INVALID');
  if (box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 || box.x + box.width > 1 || box.y + box.height > 1) {
    throw new Error('GARMENT_BBOX_OUT_OF_RANGE');
  }
  if (box.width < 0.08 || box.height < 0.08) throw new Error('GARMENT_BBOX_TOO_NARROW');
}

function cropPixels(
  box: NormalizedBoundingBox,
  imageWidth: number,
  imageHeight: number,
  slot: AmbientGarmentSlot,
  marginRatio: number,
): { left: number; top: number; width: number; height: number } {
  const marginX = box.width * marginRatio;
  const marginY = box.height * marginRatio;
  const minTop = slot === 'top' || slot === 'outerwear' || slot === 'dress' ? 0.12 : 0;
  const left = Math.max(0, box.x - marginX);
  const top = Math.max(minTop, box.y - marginY);
  const right = Math.min(1, box.x + box.width + marginX);
  const bottom = Math.min(1, box.y + box.height + marginY);
  const leftPx = Math.floor(left * imageWidth);
  const topPx = Math.floor(top * imageHeight);
  return {
    left: leftPx,
    top: topPx,
    width: Math.max(1, Math.ceil(right * imageWidth) - leftPx),
    height: Math.max(1, Math.ceil(bottom * imageHeight) - topPx),
  };
}

function userKey(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 24);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
