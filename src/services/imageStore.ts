import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AttachmentInput,
  FashionAgentContext,
  ImageKind,
  StoredImage,
} from '../types.js';
import { makeId } from '../utils/ids.js';
import { resolveWithin } from '../utils/pathSafety.js';

export class ImageStore {
  constructor(
    private readonly inputDir: string,
    private readonly outputDir: string,
  ) {}

  async ensureDirectories(): Promise<void> {
    await fs.mkdir(this.inputDir, { recursive: true });
    await fs.mkdir(this.outputDir, { recursive: true });
  }

  registerAttachment(
    context: FashionAgentContext,
    attachment: AttachmentInput,
  ): StoredImage {
    if (!attachment.localPath && !attachment.url) {
      throw new Error('Attachment must provide localPath or url.');
    }

    let localPath: string | undefined;
    if (attachment.localPath) {
      localPath = resolveWithin(this.inputDir, attachment.localPath);
    }

    const record: StoredImage = {
      id: attachment.id,
      ownerUserId: context.userId,
      sessionId: context.sessionId,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      localPath,
      url: attachment.url,
      createdAt: new Date().toISOString(),
      aiGenerated: false,
      label: attachment.label,
    };

    context.state.images[record.id] = record;
    if (attachment.makeCurrent && attachment.kind === 'user_photo') {
      context.state.currentUserImageId = record.id;
    }
    return record;
  }

  getAuthorized(
    context: FashionAgentContext,
    imageId: string,
    allowedKinds?: ImageKind[],
  ): StoredImage {
    const image = context.state.images[imageId];
    if (!image) throw new Error(`Unknown image id: ${imageId}`);
    if (
      image.ownerUserId !== context.userId ||
      image.sessionId !== context.sessionId
    ) {
      throw new Error('Image does not belong to this user/session.');
    }
    if (allowedKinds && !allowedKinds.includes(image.kind)) {
      throw new Error(`Image kind ${image.kind} is not valid for this operation.`);
    }
    return image;
  }

  getCurrentUserImage(context: FashionAgentContext): StoredImage {
    const imageId = context.state.currentUserImageId;
    if (!imageId) {
      throw new Error('No current authorized user photo is available.');
    }
    return this.getAuthorized(context, imageId, ['user_photo']);
  }

  async readImageBytes(image: StoredImage): Promise<Buffer> {
    if (!image.localPath) {
      throw new Error(
        'This MVP only reads local image files. Add an object-storage downloader for URL images.',
      );
    }
    return fs.readFile(image.localPath);
  }

  async saveGenerated(
    context: FashionAgentContext,
    args: {
      kind: Extract<ImageKind, 'ai_concept_item' | 'ai_outfit_visual' | 'ai_try_on'>;
      bytes: Buffer;
      mimeType: string;
      label: string;
    },
  ): Promise<StoredImage> {
    await this.ensureDirectories();
    const id = makeId('image');
    const extension = args.mimeType === 'image/svg+xml' ? 'svg' : 'png';
    const localPath = path.join(this.outputDir, `${id}.${extension}`);
    await fs.writeFile(localPath, args.bytes);

    const image: StoredImage = {
      id,
      ownerUserId: context.userId,
      sessionId: context.sessionId,
      kind: args.kind,
      mimeType: args.mimeType,
      localPath,
      url: localPath,
      createdAt: new Date().toISOString(),
      aiGenerated: true,
      label: args.label,
    };
    context.state.images[id] = image;
    context.state.lastGeneratedImageId = id;
    return image;
  }

  async saveTemporary(
    context: FashionAgentContext,
    args: {
      kind: Extract<ImageKind, 'ai_concept_item' | 'ai_outfit_visual' | 'ai_try_on'>;
      bytes: Buffer;
      mimeType: string;
      label: string;
    },
  ): Promise<StoredImage> {
    await this.ensureDirectories();
    const id = makeId('image_tmp');
    const extension = args.mimeType === 'image/svg+xml' ? 'svg' : 'png';
    const localPath = path.join(this.outputDir, `${id}.${extension}`);
    await fs.writeFile(localPath, args.bytes);

    return {
      id,
      ownerUserId: context.userId,
      sessionId: context.sessionId,
      kind: args.kind,
      mimeType: args.mimeType,
      localPath,
      url: localPath,
      createdAt: new Date().toISOString(),
      aiGenerated: true,
      label: args.label,
    };
  }
}
