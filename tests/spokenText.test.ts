import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSpokenText } from '../src/utils/spokenText.js';
import { speechTextForResult } from '../web/src/voice/speechText.js';

test('spoken text removes Markdown, bullets, technical IDs, and URLs', () => {
  const spoken = normalizeSpokenText(`
## 搭配建议
- **可以穿黑裤子**，但会稍微偏正式。
- 换白鞋会轻松很多，详情：https://example.com/look item_demo_123。
`);

  assert.equal(spoken, '搭配建议 可以穿黑裤子，但会稍微偏正式。换白鞋会轻松很多，详情： 。');
  assert.doesNotMatch(spoken, /[#*\-]|https?:\/\/|item_demo_123/);
});

test('Chinese spoken text preserves the first two sentences and stays within 80 characters', () => {
  const spoken = normalizeSpokenText(
    '不建议现在换成厚外套，因为室内会太热。先保留这件衬衫，鞋换成白色就够了。第三句不应该被朗读，后面还有更多解释。',
  );

  assert.equal(spoken, '不建议现在换成厚外套，因为室内会太热。先保留这件衬衫，鞋换成白色就够了。');
  assert.ok(Array.from(spoken).length <= 80);
  assert.match(spoken, /^不建议/);
});

test('English spoken text never ends in the middle of a word', () => {
  const spoken = normalizeSpokenText(
    'This recommendation keeps the outfit relaxed while preserving the strongest visual detail and avoiding unnecessary formal styling for the afternoon event.',
    { locale: 'en-US', maxEnglishWords: 12 },
  );

  assert.equal(spoken, 'This recommendation keeps the outfit relaxed while preserving the strongest visual detail');
});

test('spoken text has a safe non-empty fallback', () => {
  assert.equal(normalizeSpokenText('### *** https://example.com'), '请看屏幕上的完整回答。');
});

test('TTS selection prefers spokenText and falls back to authoritative text', () => {
  assert.equal(speechTextForResult({ spokenText: '短口播', text: '屏幕上的完整回答' }), '短口播');
  assert.equal(speechTextForResult({ spokenText: '  ', text: '屏幕上的完整回答' }), '屏幕上的完整回答');
});
