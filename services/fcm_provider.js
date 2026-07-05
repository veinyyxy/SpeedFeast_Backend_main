const crypto = require('crypto');
const fs = require('fs');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function normalizePrivateKey(value) {
  if (!value) return '';
  return value.toString().replace(/\\n/g, '\n');
}

function serviceAccountFromJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (err) {
    console.error('Invalid FCM_SERVICE_ACCOUNT_JSON:', err.message);
    return null;
  }
}

function readServiceAccountFile(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error('Unable to read GOOGLE_APPLICATION_CREDENTIALS for FCM:', err.message);
    return null;
  }
}

function loadServiceAccount() {
  const jsonAccount = serviceAccountFromJson(
    process.env.FCM_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );
  const fileAccount = jsonAccount || readServiceAccountFile(
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
  const account = fileAccount || {
    project_id: process.env.FCM_PROJECT_ID || process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FCM_CLIENT_EMAIL || process.env.FIREBASE_CLIENT_EMAIL,
    private_key: process.env.FCM_PRIVATE_KEY || process.env.FIREBASE_PRIVATE_KEY,
  };

  return {
    projectId: account.project_id || process.env.FCM_PROJECT_ID || process.env.FIREBASE_PROJECT_ID,
    clientEmail: account.client_email,
    privateKey: normalizePrivateKey(account.private_key),
  };
}

function isConfigured() {
  const account = loadServiceAccount();
  return Boolean(account.projectId && account.clientEmail && account.privateKey);
}

function createServiceAccountJwt(account) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };
  const claim = {
    iss: account.clientEmail,
    scope: FCM_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsignedToken = [
    base64UrlEncode(JSON.stringify(header)),
    base64UrlEncode(JSON.stringify(claim)),
  ].join('.');
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsignedToken)
    .sign(account.privateKey);

  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

async function fetchAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessTokenExpiresAt - 60000 > now) {
    return cachedAccessToken;
  }

  const account = loadServiceAccount();
  if (!account.projectId || !account.clientEmail || !account.privateKey) {
    throw new Error('FCM service account is not configured.');
  }

  const assertion = createServiceAccountJwt(account);
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data.error_description || data.error || `FCM auth failed with HTTP ${response.status}`
    );
  }

  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiresAt = now + (Number(data.expires_in || 3600) * 1000);
  return cachedAccessToken;
}

async function sendMessage(message) {
  const account = loadServiceAccount();
  if (!account.projectId) {
    throw new Error('FCM project id is not configured.');
  }

  const accessToken = await fetchAccessToken();
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data.error?.message || `FCM send failed with HTTP ${response.status}`
    );
    error.status = data.error?.status || response.status;
    error.details = data.error?.details || data;
    throw error;
  }

  return data;
}

module.exports = {
  isConfigured,
  sendMessage,
};
