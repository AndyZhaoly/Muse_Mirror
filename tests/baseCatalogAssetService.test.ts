import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  buildBaseCatalogAssets,
  resolveBaseCatalogStoragePath,
} from '../src/services/baseCatalogAssetService.js';
import { ClosetService } from '../src/services/closetService.js';

test('demo wardrobe absolute image paths become readable catalog assets', async () => {
  const config = loadConfig();
  const closet = new ClosetService(
    config.closetDataPath,
    config.closetPresentationMetadataPath,
  );
  const items = closet.allItems();
  const assets = await buildBaseCatalogAssets(items, {
    publicDir: path.resolve('public'),
    demo2ProductImageDir: config.demo2ProductImageDir,
  });

  assert.equal(items.length, 37);
  assert.equal(assets.size, items.length);
  for (const item of items) {
    const asset = assets.get(item.id);
    assert.ok(asset, `expected a catalog asset for ${item.id}`);
    assert.equal(asset.closetItemId, item.id);
    assert.ok(asset.storagePath?.startsWith(config.demo2ProductImageDir));
    assert.ok(asset.width > 0);
    assert.ok(asset.height > 0);
  }
});

test('catalog image resolution rejects paths outside trusted asset directories', () => {
  const directories = {
    publicDir: path.resolve('public'),
    demo2ProductImageDir: path.resolve('data/demo2-product-images'),
  };

  assert.equal(resolveBaseCatalogStoragePath('/etc/passwd', directories), undefined);
  assert.equal(
    resolveBaseCatalogStoragePath('/demo2-product-images/../../package.json', directories),
    undefined,
  );
});
