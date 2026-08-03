import { tool } from '@openai/agents';
import { z } from 'zod';
import { pushArtifact } from '../runtime/artifacts.js';
import type { ServiceContainer } from '../runtime/serviceContainer.js';
import { withToolLog } from '../runtime/toolLogging.js';
import {
  buildEditTryOnPrompt,
  buildOutfitVisualPrompt,
  buildTryOnPrompt,
} from '../services/imagePrompts.js';
import { makeId } from '../utils/ids.js';
import { asJson } from '../utils/json.js';
import { requireContext, resolveOutfit } from './helpers.js';
import { outfitSchema } from './schemas.js';

const aiDisclaimer =
  'AI 生成，仅供颜色、层次和风格参考；实际尺码、剪裁和面料垂坠以真实试穿为准。';

export function createVisualTools(services: ServiceContainer) {
  const generateOutfitVisual = tool({
    name: 'generate_outfit_visual',
    description:
      'Generate an AI flat-lay, moodboard, or mannequin-style visualization of an outfit without using the user’s identity. Use only when the user wants to see the whole styling concept or atmosphere. This output is an AI concept image, not a real product photo and not a try-on.',
    parameters: z.object({
      outfit: outfitSchema.optional(),
      mode: z.enum(['flatlay', 'moodboard', 'mannequin']).default('flatlay'),
      aspectRatio: z.enum(['1:1', '3:4', '4:5', '9:16', '16:9']).default('4:5'),
    }),
    needsApproval: async (runContext) =>
      !requireContext(runContext).permissions.allowAiImageGeneration,
    execute: async ({ outfit: supplied, mode, aspectRatio }, runContext) => {
      const context = requireContext(runContext);
      const outfit = resolveOutfit(context, supplied);
      const prompt = buildOutfitVisualPrompt({ outfit, mode });
      const generated = await withToolLog(
        context.state,
        'generate_outfit_visual',
        () => services.imageGeneration.generate(prompt, aspectRatio),
        () => `Generated ${mode} outfit concept`,
      );
      const image = await services.imageStore.saveGenerated(context, {
        kind: 'ai_outfit_visual',
        bytes: generated.bytes,
        mimeType: generated.mimeType,
        label: outfit.name ?? 'AI 搭配示意图',
      });
      pushArtifact(context.state, {
        type: 'image',
        id: makeId('artifact'),
        label: image.label ?? 'AI 搭配示意图',
        source: 'ai_outfit_visual',
        url: image.url ?? image.localPath ?? '',
        mimeType: image.mimeType,
        aiGenerated: true,
        disclaimer: aiDisclaimer,
      });
      return asJson({ imageId: image.id, url: image.url, aiGenerated: true, disclaimer: aiDisclaimer });
    },
  });

  const generateTryOnPreview = tool({
    name: 'generate_try_on_preview',
    description:
      'Generate a realistic AI preview of the user wearing the selected outfit, using an authorized user photo. Use only when the user explicitly asks what they would look like wearing it, asks for a try-on, or asks for an on-body preview. Do not use merely to show a garment or product image.',
    parameters: z.object({
      outfit: outfitSchema.optional(),
      userImageId: z.string().optional(),
      aspectRatio: z.enum(['1:1', '3:4', '4:5', '9:16']).default('4:5'),
      extraInstruction: z.string().optional(),
    }),
    needsApproval: async (runContext) =>
      !requireContext(runContext).permissions.allowAiImageGeneration ||
      !requireContext(runContext).permissions.allowPhotoUseForTryOn,
    execute: async (
      { outfit: supplied, userImageId, aspectRatio, extraInstruction },
      runContext,
    ) => {
      const context = requireContext(runContext);
      const outfit = resolveOutfit(context, supplied);
      const userImage = userImageId
        ? services.imageStore.getAuthorized(context, userImageId, ['user_photo'])
        : services.imageStore.getCurrentUserImage(context);
      const prompt = buildTryOnPrompt({ outfit, extraInstruction });
      const generated = await withToolLog(
        context.state,
        'generate_try_on_preview',
        () => services.imageGeneration.generate(prompt, aspectRatio, userImage),
        () => `Generated try-on for outfit ${outfit.id}`,
      );
      const image = await services.imageStore.saveGenerated(context, {
        kind: 'ai_try_on',
        bytes: generated.bytes,
        mimeType: generated.mimeType,
        label: `${outfit.name ?? '所选搭配'}上身预览`,
      });
      context.state.activeOutfit = outfit;
      pushArtifact(context.state, {
        type: 'image',
        id: makeId('artifact'),
        label: image.label ?? 'AI 上身预览',
        source: 'ai_try_on',
        url: image.url ?? image.localPath ?? '',
        mimeType: image.mimeType,
        aiGenerated: true,
        disclaimer: aiDisclaimer,
      });
      return asJson({ imageId: image.id, url: image.url, aiGenerated: true, disclaimer: aiDisclaimer });
    },
  });

  const editTryOnPreview = tool({
    name: 'edit_try_on_preview',
    description:
      'Edit the latest AI try-on preview or a specified try-on image according to the user’s requested change, such as changing one garment color while keeping shoes and everything else unchanged. Use for follow-up visual edits, not for a fresh unrelated image.',
    parameters: z.object({
      sourceImageId: z.string().optional(),
      changeRequest: z.string().min(1),
      aspectRatio: z.enum(['1:1', '3:4', '4:5', '9:16']).default('4:5'),
    }),
    needsApproval: async (runContext) =>
      !requireContext(runContext).permissions.allowAiImageGeneration ||
      !requireContext(runContext).permissions.allowPhotoUseForTryOn,
    execute: async ({ sourceImageId, changeRequest, aspectRatio }, runContext) => {
      const context = requireContext(runContext);
      const id = sourceImageId ?? context.state.lastGeneratedImageId;
      if (!id) throw new Error('No previous generated try-on image is available.');
      const source = services.imageStore.getAuthorized(context, id, ['ai_try_on']);
      const prompt = buildEditTryOnPrompt(changeRequest);
      const generated = await withToolLog(
        context.state,
        'edit_try_on_preview',
        () => services.imageGeneration.generate(prompt, aspectRatio, source),
        () => `Edited try-on image ${source.id}`,
      );
      const image = await services.imageStore.saveGenerated(context, {
        kind: 'ai_try_on',
        bytes: generated.bytes,
        mimeType: generated.mimeType,
        label: '修改后的上身预览',
      });
      pushArtifact(context.state, {
        type: 'image',
        id: makeId('artifact'),
        label: image.label ?? '修改后的上身预览',
        source: 'ai_try_on',
        url: image.url ?? image.localPath ?? '',
        mimeType: image.mimeType,
        aiGenerated: true,
        disclaimer: aiDisclaimer,
      });
      return asJson({ imageId: image.id, url: image.url, changed: changeRequest, disclaimer: aiDisclaimer });
    },
  });

  return [generateOutfitVisual, generateTryOnPreview, editTryOnPreview];
}
