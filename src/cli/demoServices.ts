import path from 'node:path';
import { loadConfig } from '../config.js';
import { createServiceContainer } from '../runtime/serviceContainer.js';
import { createEmptySessionState } from '../runtime/stateStore.js';
import type { FashionAgentContext, OutfitCandidate } from '../types.js';

const config = loadConfig();
const services = createServiceContainer({ ...config, mockTools: true });
const context: FashionAgentContext = {
  sessionId: 'demo_services',
  userId: 'demo_user',
  turnId: 'demo_turn',
  locale: 'zh-CN',
  nowIso: new Date().toISOString(),
  permissions: {
    allowVisualAnalysis: true,
    allowAiImageGeneration: true,
    allowPhotoUseForTryOn: true,
    allowPersistentMemory: true,
  },
  state: createEmptySessionState(),
};

services.imageStore.registerAttachment(context, {
  id: 'demo_photo',
  kind: 'user_photo',
  localPath: path.resolve('./examples/mock_user_photo.jpg'),
  mimeType: 'image/jpeg',
  makeCurrent: true,
  label: 'Demo user photo',
});

const closet = services.closet.search({ query: '松弛 约会 外套', limit: 5 });
console.log('\nCloset search:\n', closet);

const skill = services.skills.load('style-diagnosis');
console.log('\nLoaded runtime skill:\n', {
  name: skill.name,
  description: skill.description,
  references: skill.references,
});

const outfit: OutfitCandidate = {
  id: 'demo_outfit',
  name: '松弛有层次',
  occasion: '朋友晚餐',
  items: [
    { category: 'top', name: '白色 T 恤', color: 'white', fit: 'relaxed' },
    { category: 'outerwear', name: '浅卡其短夹克', color: 'light khaki', fit: 'structured-relaxed' },
    { category: 'bottom', name: '浅蓝直筒牛仔裤', color: 'light blue', fit: 'straight' },
    { category: 'shoes', name: '白色简洁运动鞋', color: 'white' },
  ],
  stylingActions: ['轻塞上衣前摆，提高腰线'],
};

console.log('\nIndependent evaluation:\n', services.evaluator.evaluate(outfit, context));

const mockImage = await services.imageGeneration.generate(
  'Create a flat-lay of a white T-shirt, khaki cropped jacket, light blue jeans and white sneakers.',
  '4:5',
);
const saved = await services.imageStore.saveGenerated(context, {
  kind: 'ai_outfit_visual',
  bytes: mockImage.bytes,
  mimeType: mockImage.mimeType,
  label: 'Demo flat-lay',
});
console.log('\nMock image saved:\n', saved.localPath);
