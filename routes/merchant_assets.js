const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const { pool } = require('../db/pgsql');
const { authenticateMerchantUploadRequest } = require('../secutiry/merchant_auth');

const router = express.Router();

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_ROOT = path.join(__dirname, '..', 'images');
const PRODUCT_IMAGE_ROOT = path.join(IMAGE_ROOT, 'products');
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

function detectImageMime(filePath) {
  const buffer = fs.readFileSync(filePath, { encoding: null, flag: 'r' });
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

function removeUploadedFile(filePath) {
  if (!filePath) return;
  fs.rm(filePath, { force: true }, () => {});
}

const storage = multer.diskStorage({
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

router.post('/assets/images/upload', (req, res, next) => {
  const authPayload = authenticateMerchantUploadRequest(req, res);
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

  let currentFilePath = file.path;
  try {
    const detectedMime = detectImageMime(file.path);
    if (!detectedMime) {
      removeUploadedFile(file.path);
      return res.status(400).json({
        success: false,
        error: 'Uploaded file is not a supported image',
      });
    }

    const detectedExtension = EXTENSION_BY_MIME.get(detectedMime);
    let filename = file.filename;
    if (detectedExtension && path.extname(filename).toLowerCase() !== detectedExtension) {
      filename = `${path.parse(filename).name}${detectedExtension}`;
      const renamedPath = path.join(path.dirname(file.path), filename);
      fs.renameSync(file.path, renamedPath);
      currentFilePath = renamedPath;
    }

    const objectKey = path.posix.join(req.productImageObjectPrefix, filename);
    const publicUrl = `/images/${objectKey}`;
    const result = await pool.query(
      `
        INSERT INTO public.media_assets (
          asset_type,
          storage_provider,
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
          'local',
          $1,
          $2,
          jsonb_build_object('original', $2::text),
          $3,
          $4,
          $5,
          'ready',
          $6::jsonb
        )
        RETURNING asset_id, public_url, object_key, mime_type, size_bytes
      `,
      [
        objectKey,
        publicUrl,
        detectedMime,
        file.size,
        normalizeOriginalFilename(file.originalname),
        JSON.stringify({
          source: 'merchant_upload',
          merchant_user_id: req.merchantAuthPayload.merchant_user_id,
          uploaded_path: currentFilePath,
        }),
      ]
    );

    const asset = result.rows[0];
    return res.status(201).json({
      success: true,
      asset,
      asset_id: asset.asset_id,
      image_url: asset.public_url,
    });
  } catch (err) {
    removeUploadedFile(currentFilePath);
    console.error('Error uploading merchant image:', err);
    return res.status(500).json({
      success: false,
      error: 'Image upload failed',
    });
  }
});

module.exports = router;
