const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createImageStorage,
  detectImageMime,
  resolveImageStorageConfig,
} = require('../services/image_storage');
const { storeMerchantImageAsset } = require('../routes/merchant_assets')._test;

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

test('image magic bytes identify supported formats and reject fake images', () => {
  assert.equal(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(detectImageMime(PNG_HEADER), 'image/png');
  assert.equal(
    detectImageMime(Buffer.from('RIFF0000WEBP', 'ascii')),
    'image/webp'
  );
  assert.equal(detectImageMime(Buffer.from('not an image')), null);
});

test('local storage remains the default for development', () => {
  assert.deepEqual(resolveImageStorageConfig({}), {
    provider: 'local',
    bucket: null,
    region: null,
    publicBaseUrl: '/images',
  });
});

test('production requires an explicit image storage provider', () => {
  assert.throws(
    () => resolveImageStorageConfig({ NODE_ENV: 'production' }),
    /IMAGE_STORAGE_PROVIDER/
  );
});

test('S3 storage requires bucket, region, and public base URL', () => {
  assert.throws(
    () => resolveImageStorageConfig({ IMAGE_STORAGE_PROVIDER: 's3' }),
    /IMAGE_S3_BUCKET/
  );
  assert.throws(
    () => resolveImageStorageConfig({
      IMAGE_STORAGE_PROVIDER: 's3',
      IMAGE_S3_BUCKET: 'images',
    }),
    /AWS_REGION/
  );
  assert.throws(
    () => resolveImageStorageConfig({
      IMAGE_STORAGE_PROVIDER: 's3',
      IMAGE_S3_BUCKET: 'images',
      AWS_REGION: 'ca-central-1',
    }),
    /IMAGE_PUBLIC_BASE_URL/
  );
});

test('S3 storage builds encoded public URLs and sends SDK commands', async () => {
  const commands = [];
  class PutObjectCommand {
    constructor(input) { this.input = input; }
  }
  class DeleteObjectCommand {
    constructor(input) { this.input = input; }
  }
  const storage = createImageStorage({
    config: {
      provider: 's3',
      bucket: 'speedfeast-images',
      region: 'ca-central-1',
      publicBaseUrl: 'https://images.example.com',
    },
    s3Client: {
      async send(command) { commands.push(command); },
    },
    s3Sdk: { PutObjectCommand, DeleteObjectCommand },
  });

  assert.equal(
    storage.publicUrl('products/2026/07/a file.png'),
    'https://images.example.com/products/2026/07/a%20file.png'
  );
  await storage.upload({
    objectKey: 'products/2026/07/image.png',
    buffer: PNG_HEADER,
    contentType: 'image/png',
  });
  await storage.remove('products/2026/07/image.png');

  assert.equal(commands.length, 2);
  assert.equal(commands[0].input.Bucket, 'speedfeast-images');
  assert.equal(commands[0].input.ContentType, 'image/png');
  assert.equal(commands[1].input.Key, 'products/2026/07/image.png');
});

test('S3 object is deleted when the media_assets insert fails', async () => {
  const uploaded = [];
  const removed = [];
  const storageClient = {
    provider: 's3',
    bucket: 'speedfeast-images',
    publicUrl: (key) => `https://images.example.com/${key}`,
    async upload(value) { uploaded.push(value); },
    async remove(key) { removed.push(key); },
  };
  const dbPool = {
    async query() { throw new Error('database unavailable'); },
  };

  await assert.rejects(
    storeMerchantImageAsset({
      file: {
        buffer: PNG_HEADER,
        size: PNG_HEADER.length,
        originalname: 'menu.png',
        mimetype: 'image/png',
      },
      productImageObjectPrefix: 'products/2026/07',
      merchantAuthPayload: { merchant_user_id: 'merchant-user-1' },
      storageClient,
      dbPool,
    }),
    /database unavailable/
  );

  assert.equal(uploaded.length, 1);
  assert.deepEqual(removed, [uploaded[0].objectKey]);
});

test('S3 media record contains provider, bucket, key, and public URL', async () => {
  let query;
  const storageClient = {
    provider: 's3',
    bucket: 'speedfeast-images',
    publicUrl: (key) => `https://images.example.com/${key}`,
    async upload() {},
    async remove() {},
  };
  const dbPool = {
    async query(text, params) {
      query = { text, params };
      return { rows: [{ asset_id: 'asset-1', public_url: params[3] }] };
    },
  };

  const asset = await storeMerchantImageAsset({
    file: {
      buffer: PNG_HEADER,
      size: PNG_HEADER.length,
      originalname: 'menu.png',
      mimetype: 'image/png',
    },
    productImageObjectPrefix: 'products/2026/07',
    merchantAuthPayload: { merchant_user_id: 'merchant-user-1' },
    storageClient,
    dbPool,
  });

  assert.equal(asset.asset_id, 'asset-1');
  assert.match(query.text, /storage_provider/);
  assert.match(query.text, /bucket/);
  assert.equal(query.params[0], 's3');
  assert.equal(query.params[1], 'speedfeast-images');
  assert.match(query.params[2], /^products\/2026\/07\/.+\.png$/);
  assert.equal(query.params[3], `https://images.example.com/${query.params[2]}`);
});
