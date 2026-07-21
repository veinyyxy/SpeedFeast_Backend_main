const path = require('path');

const SUPPORTED_IMAGE_MIMES = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
});

function isProductionEnvironment(env) {
  return ['prod', 'production'].includes(
    String(env.NODE_ENV || '').trim().toLowerCase()
  );
}

function normalizeProvider(value, env) {
  if (!value && isProductionEnvironment(env)) {
    throw new Error('IMAGE_STORAGE_PROVIDER is required in production');
  }
  const provider = (value || 'local').toString().trim().toLowerCase();
  if (provider !== 'local' && provider !== 's3') {
    throw new Error('IMAGE_STORAGE_PROVIDER must be either "local" or "s3"');
  }
  return provider;
}

function normalizePublicBaseUrl(value) {
  const publicBaseUrl = (value || '').toString().trim().replace(/\/+$/, '');
  if (!publicBaseUrl) {
    throw new Error('IMAGE_PUBLIC_BASE_URL is required when IMAGE_STORAGE_PROVIDER=s3');
  }

  let parsed;
  try {
    parsed = new URL(publicBaseUrl);
  } catch (_err) {
    throw new Error('IMAGE_PUBLIC_BASE_URL must be a valid http(s) URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('IMAGE_PUBLIC_BASE_URL must be a valid http(s) URL');
  }
  return publicBaseUrl;
}

function resolveImageStorageConfig(env = process.env) {
  const provider = normalizeProvider(env.IMAGE_STORAGE_PROVIDER, env);
  if (provider === 'local') {
    return {
      provider,
      bucket: null,
      region: null,
      publicBaseUrl: '/images',
    };
  }

  const bucket = (env.IMAGE_S3_BUCKET || '').toString().trim();
  const region = (env.AWS_REGION || '').toString().trim();
  if (!bucket) {
    throw new Error('IMAGE_S3_BUCKET is required when IMAGE_STORAGE_PROVIDER=s3');
  }
  if (!region) {
    throw new Error('AWS_REGION is required when IMAGE_STORAGE_PROVIDER=s3');
  }

  return {
    provider,
    bucket,
    region,
    publicBaseUrl: normalizePublicBaseUrl(env.IMAGE_PUBLIC_BASE_URL),
  };
}

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

function extensionForMime(mimeType) {
  return SUPPORTED_IMAGE_MIMES[mimeType] || null;
}

function joinPublicUrl(baseUrl, objectKey) {
  const normalizedKey = objectKey
    .split(path.posix.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${baseUrl.replace(/\/+$/, '')}/${normalizedKey}`;
}

function loadS3Sdk() {
  try {
    return require('@aws-sdk/client-s3');
  } catch (err) {
    err.message = `@aws-sdk/client-s3 is required for S3 image storage: ${err.message}`;
    throw err;
  }
}

function createImageStorage(options = {}) {
  const config = options.config || resolveImageStorageConfig(options.env);
  let s3Client = options.s3Client || null;
  let s3Sdk = options.s3Sdk || null;

  function getS3Dependencies() {
    if (config.provider !== 's3') return null;
    s3Sdk = s3Sdk || loadS3Sdk();
    s3Client = s3Client || new s3Sdk.S3Client({ region: config.region });
    return { s3Client, s3Sdk };
  }

  return {
    provider: config.provider,
    bucket: config.bucket,
    region: config.region,

    publicUrl(objectKey) {
      return joinPublicUrl(config.publicBaseUrl, objectKey);
    },

    async upload({ objectKey, buffer, contentType, metadata }) {
      if (config.provider !== 's3') {
        throw new Error('upload() is only available for S3 image storage');
      }
      const dependencies = getS3Dependencies();
      await dependencies.s3Client.send(new dependencies.s3Sdk.PutObjectCommand({
        Bucket: config.bucket,
        Key: objectKey,
        Body: buffer,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
        Metadata: metadata,
      }));
    },

    async remove(objectKey) {
      if (config.provider !== 's3') return;
      const dependencies = getS3Dependencies();
      await dependencies.s3Client.send(new dependencies.s3Sdk.DeleteObjectCommand({
        Bucket: config.bucket,
        Key: objectKey,
      }));
    },
  };
}

module.exports = {
  createImageStorage,
  detectImageMime,
  extensionForMime,
  joinPublicUrl,
  resolveImageStorageConfig,
};
