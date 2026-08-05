import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeSpokenText,
  type CriticalSpokenNotice,
} from '../src/utils/spokenText.js';
import { speechTextForResult } from '../web/src/voice/speechText.js';

const fitNotice: CriticalSpokenNotice = {
  kind: 'fit_uncertain',
  priority: 200,
  text: '具体肩线、腰围和裤长仍要试穿确认。',
};

const closetNotice: CriticalSpokenNotice = {
  kind: 'closet_incomplete',
  priority: 100,
  text: '衣柜现有单品还不够组成完整一套，主要缺鞋子。',
};

test('spoken text removes pure Markdown headings but keeps heading conclusions', () => {
  const spoken = normalizeSpokenText(`
## 搭配建议
### 推荐单品
## 不建议换厚外套，因为室内会太热。
`);

  assert.equal(spoken, '不建议换厚外套，因为室内会太热。');
  assert.doesNotMatch(spoken, /搭配建议|推荐单品|#/);
});

test('spoken text removes bullets, URLs, opaque IDs, empty labels, and broken punctuation', () => {
  const spoken = normalizeSpokenText(`
## 搭配建议
- **可以穿黑裤子**，但会稍微偏正式。
- 换白鞋会轻松很多，详情：https://example.com/look item_demo_123。
- 链接：www.example.com
`);

  assert.equal(spoken, '可以穿黑裤子，但会稍微偏正式。换白鞋会轻松很多。');
  assert.doesNotMatch(spoken, /搭配建议|详情|链接|https?:\/\/|item_demo_123|[#*]|：。|。。/);
});

test('spoken text cleans empty labels and abnormal punctuation without deleting real reasons', () => {
  const spoken = normalizeSpokenText(
    '原因：黑裤会更正式。详情：https://example.com，网址：www.example.com。建议：，不要换厚外套。。',
  );

  assert.match(spoken, /^原因：黑裤会更正式。/);
  assert.match(spoken, /不要换厚外套。$/);
  assert.doesNotMatch(spoken, /详情|网址|：，|：。|。。/);
});

test('Chinese spoken text preserves the first two sentences and ends naturally', () => {
  const spoken = normalizeSpokenText(
    '不建议现在换成厚外套，因为室内会太热。先保留这件衬衫，鞋换成白色就够了。第三句不应该被朗读，后面还有更多解释。',
  );

  assert.equal(spoken, '不建议现在换成厚外套，因为室内会太热。先保留这件衬衫，鞋换成白色就够了。');
  assert.ok(Array.from(spoken).length <= 80);
  assert.match(spoken, /^不建议/);
  assert.match(spoken, /。$/);
});

test('English spoken text never ends in the middle of a word and ends naturally', () => {
  const spoken = normalizeSpokenText(
    'This recommendation keeps the outfit relaxed while preserving the strongest visual detail and avoiding unnecessary formal styling for the afternoon event.',
    { locale: 'en-US', maxEnglishWords: 12 },
  );

  assert.equal(spoken, 'This recommendation keeps the outfit relaxed while preserving the strongest visual detail.');
});

test('cleanup preserves negation, uncertainty, provenance, and authorization language', () => {
  const spoken = normalizeSpokenText(
    '不建议现在生成，因为没有可靠画面。这不是衣柜单品，仍需确认，也可能需要授权。',
  );

  assert.match(spoken, /不建议/);
  assert.match(spoken, /没有可靠画面/);
  assert.match(spoken, /不是衣柜单品/);
  assert.match(spoken, /仍需确认/);
  assert.match(spoken, /可能需要授权/);
});

test('critical fit notice survives after two ordinary model sentences', () => {
  const spoken = normalizeSpokenText(
    '这套适合约会。白色运动鞋会更轻松。屏幕上还有更多解释。',
    { criticalNotices: [fitNotice] },
  );

  assert.equal(spoken, '这套适合约会。具体肩线、腰围和裤长仍要试穿确认。');
  assert.doesNotMatch(spoken, /屏幕上还有更多解释/);
});

test('critical closet notice survives after two ordinary model sentences', () => {
  const spoken = normalizeSpokenText(
    '这套方向很适合通勤。整体颜色也很协调。',
    { criticalNotices: [closetNotice] },
  );

  assert.match(spoken, /^这套方向很适合通勤。/);
  assert.match(spoken, /衣柜现有单品还不够组成完整一套，主要缺鞋子。/);
});

test('fit and closet notices are both retained in priority order within the voice limit', () => {
  const spoken = normalizeSpokenText(
    '这套可以直接作为搭配方向。第二句普通理由不会挤掉关键限制。',
    { criticalNotices: [closetNotice, fitNotice] },
  );

  assert.ok(spoken.indexOf('试穿确认') < spoken.indexOf('衣柜现有单品'));
  assert.match(spoken, /试穿确认/);
  assert.match(spoken, /主要缺鞋子/);
  assert.ok(Array.from(spoken).length <= 80);
  assert.doesNotMatch(spoken, /第一|第二/);
});

test('critical notice priority is visual, fit, then closet', () => {
  const spoken = normalizeSpokenText('先说结论。', {
    criticalNotices: [
      closetNotice,
      { kind: 'visual_unavailable', priority: 300, text: '我没有可靠的视觉结果，不能假装看见你。' },
      fitNotice,
    ],
  });

  assert.ok(spoken.indexOf('视觉结果') < spoken.indexOf('试穿确认'));
  assert.ok(spoken.indexOf('试穿确认') < spoken.indexOf('衣柜现有单品'));
});

test('notices already expressed in the retained main sentence are not repeated', () => {
  const fit = normalizeSpokenText(
    '这几件方向合适，但具体尺码仍要试穿确认。屏幕上还有详细原因。',
    { criticalNotices: [fitNotice] },
  );
  const closet = normalizeSpokenText(
    '衣柜现有单品还不够组成完整一套，主要缺鞋子。屏幕上还有柜外建议。',
    { criticalNotices: [closetNotice] },
  );

  assert.equal(fit.match(/试穿确认/g)?.length, 1);
  assert.equal(closet.match(/不够组成完整一套/g)?.length, 1);
});

test('visual unavailable safety fallback remains complete and speakable', () => {
  const authoritative = '我这边还没有拿到当前画面的视觉结果，所以不能假装已经看见你。你可以让镜子重新带一帧当前画面。';
  const spoken = normalizeSpokenText(authoritative, {
    criticalNotices: [
      { kind: 'visual_unavailable', priority: 300, text: '我没有可靠的视觉结果，不能假装看见你。' },
    ],
  });

  assert.equal(spoken, authoritative);
  assert.match(spoken, /没有拿到当前画面的视觉结果/);
  assert.match(spoken, /不能假装已经看见你/);
});

test('normalization never mutates authoritative text and has a safe non-empty fallback', () => {
  const authoritative = '## 建议\n- 不建议换厚外套。';
  const original = authoritative.slice();
  normalizeSpokenText(authoritative, { criticalNotices: [fitNotice] });
  assert.equal(authoritative, original);
  assert.equal(normalizeSpokenText('### *** https://example.com'), '请看屏幕上的完整回答。');
});

test('TTS selection prefers spokenText, falls back only when empty, and ignores other turn fields', () => {
  assert.equal(speechTextForResult({ spokenText: '短口播', text: '屏幕上的完整回答' }), '短口播');
  assert.equal(speechTextForResult({ spokenText: '  ', text: '屏幕上的完整回答' }), '屏幕上的完整回答');
  assert.equal(speechTextForResult({
    spokenText: '只读这句',
    text: '屏幕正文',
    commentary: '不要读 commentary',
    activity: ['不要读 activity'],
    artifacts: ['不要读 artifact'],
  } as any), '只读这句');
});
