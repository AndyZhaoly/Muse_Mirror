import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  FashionSkillRegistry,
  runtimeFashionSkillNames,
} from '../src/services/skillRegistry.js';

const registry = new FashionSkillRegistry(path.resolve('./skills'));

test('runtime skill catalog exposes only metadata and valid references', () => {
  const catalog = registry.catalog();
  assert.deepEqual(
    catalog.map((skill) => skill.name),
    [...runtimeFashionSkillNames],
  );
  for (const skill of catalog) {
    assert.ok(skill.description.length > 30);
    assert.equal('instructions' in skill, false);
  }
});

test('skill instructions and references load progressively', () => {
  const skill = registry.load('style-diagnosis');
  assert.match(skill.instructions ?? '', /visible facts|可见|outfit/i);
  assert.ok(skill.references.includes('color.md'));

  const reference = registry.load('style-diagnosis', 'color.md');
  assert.match(reference.reference?.content ?? '', /color|颜色/i);
  assert.equal(reference.instructions, undefined);
});

test('skill registry rejects unknown or traversal references', () => {
  assert.throws(
    () => registry.load('style-diagnosis', '../SKILL.md'),
    /Unknown reference/,
  );
});
