import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createServiceContainer } from '../src/runtime/serviceContainer.js';
import { createFashionTools } from '../src/tools/index.js';

const tools = createFashionTools(
  createServiceContainer({ ...loadConfig(), mockTools: true }),
);
const names = tools.map((tool) => tool.name);

test('visual tools have distinct, explicit responsibilities', () => {
  const descriptions = Object.fromEntries(
    tools.map((tool) => [tool.name, tool.description.toLowerCase()]),
  );
  assert.match(descriptions.get_item_images ?? '', /real images|真实/);
  assert.match(descriptions.generate_outfit_visual ?? '', /without using the user|不含/);
  assert.match(descriptions.generate_try_on_preview ?? '', /wearing|穿上|try-on/);
});

test('stable styling methods are skills, not one tool per thought', () => {
  assert.ok(names.includes('load_fashion_skill'));
  assert.equal(names.includes('retrieve_style_knowledge'), false);
  assert.equal(names.includes('check_color'), false);
  assert.equal(names.includes('check_proportion'), false);
  assert.equal(names.includes('check_silhouette'), false);
});

test('independent evaluator is clearly separated from ordinary skill review', () => {
  const verifier = tools.find((tool) => tool.name === 'verify_outfit_quality');
  assert.ok(verifier);
  assert.match(verifier.description.toLowerCase(), /independent|structured/);
});

test('there is no fixed intent-classifier tool', () => {
  assert.equal(names.some((name) => name.includes('classify_intent')), false);
});
