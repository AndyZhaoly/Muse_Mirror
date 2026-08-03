import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractPartialJsonStringField,
  StreamingJsonTextExtractor,
} from '../src/utils/streamingJsonText.js';

test('extracts partial JSON text field before the full object is complete', () => {
  assert.equal(
    extractPartialJsonStringField('{"text":"你好，Muse', 'text'),
    '你好，Muse',
  );
});

test('streams only newly available text deltas', () => {
  const extractor = new StreamingJsonTextExtractor();
  assert.equal(extractor.next('{"text":"你好'), '你好');
  assert.equal(extractor.next('{"text":"你好，今天'), '，今天');
  assert.equal(extractor.next('{"text":"你好，今天\\n继续"'), '\n继续');
  assert.equal(extractor.next('{"text":"你好，今天\\n继续"'), undefined);
});
