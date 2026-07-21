const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const { pool } = require('../db/pgsql');
const { authorizeMerchantUploadRequest } = require('../secutiry/merchant_auth');
const {
  createImageStorage,
  detectImageMime,
  extensionForMime,
} = require('../services/image_storage');
const { PERMISSIONS } = require('../services/merchant_authorization');

const router = express.Router();

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_ROOT = path.join(__dirname, '..', 'images');
const PRODUCT_IMAGE_ROOT = path.join(IMAGE_ROOT, 'products');
const imageStorage = createImageStorage();
const MIME_BY_EXTENSION = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);
const EXTENSION_BY_MIME = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

function imageDateParts(now = new Date()) {
  return {
    year: now.getFullYear().toString(),
    month: (now.getMonth() + 1).toString().padStart(2, '0'),
  };
}

function normalizeOriginalFilename(value) {
  if (!value) return 'image';
  return path.basename(value.toString()).slice(0, 180) || 'image';
}

function resolveImageExtension(filename, mimeType) {
  const extension = path.extname(filename || '').toLowerCase();
  if (MIME_BY_EXTENSION.has(extension)) return extension === '.jpeg' ? '.jpg' : extension;
  return EXTENSION_BY_MIME.get((mimeType || '').toLowerCase()) || null;
}

function removeUploadedFile(filePath) {
  if (!filePath) return;
  fs.rm(filePath, { force: true }, () => {});
}

const localStorage = multer.diskStorage({
  destination(req, file, callback) {
    const { year, month } = imageDateParts();
    req.productImageObjectPrefix = path.posix.join('products', year, month);
    const directory = path.join(PRODUCT_IMAGE_ROOT, year, month);
    fs.mkdirSync(directory, { recursive: true });
    callback(null, directory);
  },
  filename(req, file, callback) {
    const extension = resolveImageExtension(file.originalname, file.mimetype);
    if (!extension) {
      callback(new Error('Only JPG, PNG, and WebP images are allowed.'));
      return;
    }
    callback(null, `${crypto.randomUUID()}${extension}`);
  },
});

const storage = imageStorage.provider === 's3'
  ? multer.memoryStorage()
  : localStorage;

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1,
  },
  fileFilter(req, file, callback) {
    const extension = resolveImageExtension(file.originalname, file.mimetype);
    if (!extension) {
      callback(new Error('Only JPG, PNG, and WebP images are allowed.'));
      return;
    }
    callback(null, true);
  },
});

function handleUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) {
      next();
      return;
    }

    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        error: 'Image must be 5MB or smaller',
      });
    }

    return res.status(400).json({
      success: false,
      error: err.message || 'Image upload failed',
    });
  });
}

class UnsupportedImageError extends Error {}

async function removeStoredImage(storageClient, objectKey, localFilePath) {
  if (storageClient.provider === 's3' && objectKey) {
    try {
      await storageClient.remove(objectKey);
    } catch (err) {
      console.error('Error removing uploaded S3 image:', err);
    }
    return;
  }
  removeUploadedFile(localFilePath);
}

async function storeMerchantImageAsset({
  file,
  productImageObjectPrefix,
  merchantAuthPayload,
  storageClient = imageStorage,
  dbPool = pool,
}) {
  let currentFilePath = file.path || null;
  let objectKey = null;
  let uploadedToS3 = false;

  try {
    const imageBuffer = file.buffer || fs.readFileSync(file.path, {
      encoding: null,
      flag: 'r',
    });
    const detectedMime = detectImageMime(imageBuffer);
    if (!detectedMime) {
      throw new UnsupportedImageError('Uploaded file is not a supported image');
    }

    const detectedExtension = extensionForMime(detectedMime);
    let filename = file.filename || `${crypto.randomUUID()}${detectedExtension}`;
    if (path.extname(filename).toLowerCase() !== detectedExtension) {
      filename = `${path.parse(filename).name}${detectedExtension}`;
      if (storageClient.provider === 'local') {
        const renamedPath = path.join(path.dirname(file.path), filename);
        fs.renameSync(file.path, renamedPath);
        currentFilePath = renamedPath;
      }
    }

    objectKey = path.posix.join(productImageObjectPrefix, filename);
    const publicUrl = storageClient.publicUrl(objectKey);

    if (storageClient.provider === 's3') {
      await storageClient.upload({
        objectKey,
        buffer: imageBuffer,
        contentType: detectedMime,
        metadata: { source: 'merchant-upload' },
      });
      uploadedToS3 = true;
    }

    const metadata = {
      source: 'merchant_upload',
      merchant_user_id: merchantAuthPayload.merchant_user_id,
    };
    if (currentFilePath) metadata.uploaded_path = currentFilePath;

    const result = await dbPool.query(
      `
        INSERT INTO public.media_assets (
          asset_type,
          storage_provider,
          bucket,
          object_key,
          public_url,
          variants,
          mime_type,
          size_bytes,
          original_filename,
          status,
          metadata
        )
        VALUES (
          'image',
          $1,
          $2,
          $3,
          $4,
          jsonb_build_object('original', $4::text),
          $5,
          $6,
          $7,
          'ready',
          $8::jsonb
        )
        RETURNING asset_id, public_url, object_key, mime_type, size_bytes
      `,
      [
        storageClient.provider,
        storageClient.bucket,
        objectKey,
        publicUrl,
        detectedMime,
        file.size,
        normalizeOriginalFilename(file.originalname),
        JSON.stringify(metadata),
      ]
    );

    return result.rows[0];
  } catch (err) {
    await removeStoredImage(
      storageClient,
      uploadedToS3 ? objectKey : null,
      currentFilePath
    );
    throw err;
  }
}

router.post('/assets/images/upload', async (req, res, next) => {
  const authPayload = await authorizeMerchantUploadRequest(
    req,
    res,
    [PERMISSIONS.PRODUCTS_MANAGE, PERMISSIONS.SETTINGS_STORE_MANAGE],
    { permissionMode: 'any' }
  );
  if (!authPayload) return;
  req.merchantAuthPayload = authPayload;
  next();
}, handleUpload, async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({
      success: false,
      error: 'image file is required',
    });
  }

  try {
    const { year, month } = imageDateParts();
    const productImageObjectPrefix = req.productImageObjectPrefix ||
      path.posix.join('products', year, month);
    const asset = await storeMerchantImageAsset({
      file,
      productImageObjectPrefix,
      merchantAuthPayload: req.merchantAuthPayload,
    });
    return res.status(201).json({
      success: true,
      asset,
      asset_id: asset.asset_id,
      image_url: asset.public_url,
    });
  } catch (err) {
    if (err instanceof UnsupportedImageError) {
      return res.status(400).json({
        success: false,
        error: err.message,
      });
    }
    console.error('Error uploading merchant image:', err);
    return res.status(500).json({
      success: false,
      error: 'Image upload failed',
    });
  }
});

module.exports = router;
module.exports._test = {
  UnsupportedImageError,
  storeMerchantImageAsset,
};
