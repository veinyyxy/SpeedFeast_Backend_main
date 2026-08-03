const { randomInt } = require('node:crypto');

const STORE_IDENTIFIER_LETTERS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const STORE_IDENTIFIER_PATTERN = /^[A-Za-z]{3}[0-9]{3}$/;
const STORE_IDENTIFIER_LOCK_ID = '835706120240802';
const DEFAULT_MAX_ATTEMPTS = 100;

function generateStoreIdentifier(randomIntFn = randomInt) {
  let identifier = '';
  for (let index = 0; index < 3; index += 1) {
    identifier += STORE_IDENTIFIER_LETTERS[
      randomIntFn(0, STORE_IDENTIFIER_LETTERS.length)
    ];
  }
  for (let index = 0; index < 3; index += 1) {
    identifier += randomIntFn(0, 10).toString();
  }
  return identifier;
}

async function generateUniqueStoreIdentifiers(db, options = {}) {
  const generateIdentifier =
    options.generateIdentifier || generateStoreIdentifier;
  const maxAttempts = Math.max(
    1,
    Number.parseInt(options.maxAttempts, 10) || DEFAULT_MAX_ATTEMPTS
  );

  await db.query(
    'SELECT pg_advisory_xact_lock($1::bigint)',
    [STORE_IDENTIFIER_LOCK_ID]
  );

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const storeCode = generateIdentifier();
    const slug = generateIdentifier();
    if (
      !STORE_IDENTIFIER_PATTERN.test(storeCode) ||
      !STORE_IDENTIFIER_PATTERN.test(slug) ||
      storeCode.toLowerCase() === slug.toLowerCase()
    ) {
      continue;
    }

    const normalizedIdentifiers = [
      storeCode.toLowerCase(),
      slug.toLowerCase(),
    ];
    const existingResult = await db.query(
      `
        SELECT 1
        FROM public.stores
        WHERE lower(store_code) = ANY($1::text[])
           OR lower(slug) = ANY($1::text[])
        LIMIT 1
      `,
      [normalizedIdentifiers]
    );
    if (existingResult.rowCount === 0) {
      return { storeCode, slug };
    }
  }

  const error = new Error('Unable to generate unique store identifiers');
  error.code = 'STORE_IDENTIFIER_GENERATION_FAILED';
  throw error;
}

module.exports = {
  STORE_IDENTIFIER_PATTERN,
  generateStoreIdentifier,
  generateUniqueStoreIdentifiers,
};
