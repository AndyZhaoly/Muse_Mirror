import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type {
  AmbientGarmentSlot,
  GarmentImageAsset,
  NormalizedBoundingBox,
  WornGarmentObservation,
} from '../domain/ambientCapture.js';
import { makeId } from '../utils/ids.js';

export interface GarmentCropInput {
  userId: string;
  sourceFramePath: string;
  sourceFrameId: string;
  observationItemId: string;
  boundingBox: NormalizedBoundingBox;
  slot: AmbientGarmentSlot;
  role?: 'track_identity_evidence' | 'garment_appearance';
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

export interface AmbientCaptureDiagnosticBundleInput {
  userId: string;
  episodeId: string;
  observationId: string;
  frameId: string;
  capturedAt: string;
  evidenceAsset?: GarmentImageAsset;
  appearanceAssets: GarmentImageAsset[];
  garments: WornGarmentObservation[];
  retentionLimit?: number;
}

export interface AmbientCaptureDiagnosticBundle {
  bundleId: string;
  relativeDirectory: string;
  manifestFile: string;
  createdAt: string;
  frameId: string;
  observationId: string;
  assetIds: string[];
}

interface AmbientCaptureDiagnosticManifest extends AmbientCaptureDiagnosticBundle {
  schemaVersion: 1;
  episodeId: string;
  assets: Array<{
    assetId: string;
    role: GarmentImageAsset['role'];
    fileName: string;
    sourceFrameId?: string;
    observationItemId?: string;
    width: number;
    height: number;
    mimeType: GarmentImageAsset['mimeType'];
    contentHash: string;
  }>;
  garments: Array<{
    observationItemId: string;
    slot: WornGarmentObservation['slot'];
    category: WornGarmentObservation['category'];
    dominantColor: string;
    pattern: string;
    boundingBox: NormalizedBoundingBox;
    confidence: number;
    appearanceAssetId?: string;
  }>;
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
    const role = input.role ?? 'garment_appearance';
    const asset = await this.writeAsset({
      userId: input.userId,
      role,
      prefix: role === 'track_identity_evidence' ? 'track-evidence' : 'appearance',
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

  async storeDiagnosticCapture(
    input: AmbientCaptureDiagnosticBundleInput,
  ): Promise<AmbientCaptureDiagnosticBundle | undefined> {
    const assets = [
      ...(input.evidenceAsset ? [input.evidenceAsset] : []),
      ...input.appearanceAssets,
    ].filter((asset, index, all) => all.findIndex((candidate) => candidate.assetId === asset.assetId) === index);
    if (!assets.length) return undefined;

    const bundleId = makeId('ambient_capture_debug');
    const relativeDirectory = path.join(
      'diagnostics',
      'ambient-captures',
      userKey(input.userId),
      `${sortableTimestamp(input.capturedAt)}_${safePathSegment(input.frameId)}_${bundleId}`,
    );
    const directory = path.join(this.options.rootDirectory, relativeDirectory);
    await fs.mkdir(directory, { recursive: true });

    try {
      const manifestAssets: AmbientCaptureDiagnosticManifest['assets'] = [];
      for (const [index, asset] of assets.entries()) {
        if (!asset.storagePath || !isWithin(this.options.rootDirectory, asset.storagePath)) {
          throw new Error('DIAGNOSTIC_CAPTURE_ASSET_OUTSIDE_ROOT');
        }
        const extension = extensionForMimeType(asset.mimeType);
        const descriptor = asset.role === 'capture_evidence'
          ? 'frame'
          : safePathSegment(asset.observationItemId ?? `garment-${index}`);
        const fileName = `${String(index + 1).padStart(2, '0')}_${descriptor}_${safePathSegment(asset.assetId)}.${extension}`;
        await fs.copyFile(asset.storagePath, path.join(directory, fileName));
        manifestAssets.push({
          assetId: asset.assetId,
          role: asset.role,
          fileName,
          sourceFrameId: asset.sourceFrameId,
          observationItemId: asset.observationItemId,
          width: asset.width,
          height: asset.height,
          mimeType: asset.mimeType,
          contentHash: asset.contentHash,
        });
      }

      const appearanceByObservation = new Map(
        input.appearanceAssets.flatMap((asset) => asset.observationItemId ? [[asset.observationItemId, asset.assetId] as const] : []),
      );
      const manifestFile = 'manifest.json';
      const manifest: AmbientCaptureDiagnosticManifest = {
        schemaVersion: 1,
        bundleId,
        relativeDirectory,
        manifestFile,
        createdAt: input.capturedAt,
        frameId: input.frameId,
        observationId: input.observationId,
        episodeId: input.episodeId,
        assetIds: manifestAssets.map((asset) => asset.assetId),
        assets: manifestAssets,
        garments: input.garments.map((garment) => ({
          observationItemId: garment.observationItemId,
          slot: garment.slot,
          category: garment.category,
          dominantColor: garment.dominantColor,
          pattern: garment.pattern,
          boundingBox: garment.boundingBox,
          confidence: garment.confidence,
          appearanceAssetId: appearanceByObservation.get(garment.observationItemId),
        })),
      };
      const temporaryManifest = path.join(directory, `${manifestFile}.tmp`);
      await fs.writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
      await fs.rename(temporaryManifest, path.join(directory, manifestFile));
      await this.pruneDiagnosticCaptures(input.userId, input.retentionLimit ?? 100);
      return {
        bundleId,
        relativeDirectory,
        manifestFile,
        createdAt: input.capturedAt,
        frameId: input.frameId,
        observationId: input.observationId,
        assetIds: manifest.assetIds,
      };
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async listDiagnosticCaptures(userId: string, limit = 50): Promise<AmbientCaptureDiagnosticBundle[]> {
    const root = this.diagnosticUserDirectory(userId);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const directories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => ({
      name: entry.name,
      modifiedAt: (await fs.stat(path.join(root, entry.name))).mtimeMs,
    })));
    const results: AmbientCaptureDiagnosticBundle[] = [];
    for (const entry of directories.sort((left, right) => right.modifiedAt - left.modifiedAt).slice(0, Math.max(0, limit))) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(root, entry.name, 'manifest.json'), 'utf8')) as AmbientCaptureDiagnosticManifest;
        if (parsed.schemaVersion !== 1 || !parsed.bundleId || !Array.isArray(parsed.assetIds)) continue;
        results.push({
          bundleId: parsed.bundleId,
          relativeDirectory: parsed.relativeDirectory,
          manifestFile: parsed.manifestFile,
          createdAt: parsed.createdAt,
          frameId: parsed.frameId,
          observationId: parsed.observationId,
          assetIds: parsed.assetIds,
        });
      } catch {
        // A partially written or manually damaged diagnostic bundle is ignored,
        // never rewritten, so the remaining evidence can still be inspected.
      }
    }
    return results;
  }

  private diagnosticUserDirectory(userId: string): string {
    return path.join(this.options.rootDirectory, 'diagnostics', 'ambient-captures', userKey(userId));
  }

  private async pruneDiagnosticCaptures(userId: string, limit: number): Promise<void> {
    const root = this.diagnosticUserDirectory(userId);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const directories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => ({
      name: entry.name,
      modifiedAt: (await fs.stat(path.join(root, entry.name))).mtimeMs,
    })));
    const retained = Math.max(1, Math.round(limit));
    await Promise.all(directories
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(retained)
      .map((entry) => fs.rm(path.join(root, entry.name), { recursive: true, force: true })));
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
      perceptualHash: await differenceHash(input.bytes),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
  }
}

export async function differenceHash(bytes: Buffer): Promise<string> {
  const pixels = await sharp(bytes, { failOn: 'error' })
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();
  let bits = '';
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const offset = row * 9 + column;
      bits += (pixels[offset] ?? 0) > (pixels[offset + 1] ?? 0) ? '1' : '0';
    }
  }
  return Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(bits.slice(index * 4, index * 4 + 4), 2).toString(16)).join('');
}

export function perceptualHashDistance(left: string | undefined, right: string | undefined): number | undefined {
  if (!left || !right || left.length !== right.length) return undefined;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftNibble = Number.parseInt(left[index]!, 16);
    const rightNibble = Number.parseInt(right[index]!, 16);
    if (!Number.isFinite(leftNibble) || !Number.isFinite(rightNibble)) return undefined;
    let xor = leftNibble ^ rightNibble;
    while (xor) {
      distance += xor & 1;
      xor >>>= 1;
    }
  }
  return distance;
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

function extensionForMimeType(mimeType: GarmentImageAsset['mimeType']): string {
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/png') return 'png';
  return 'jpg';
}

function safePathSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.slice(0, 96) || 'capture';
}

function sortableTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().replace(/[:.]/g, '-')
    : new Date().toISOString().replace(/[:.]/g, '-');
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
