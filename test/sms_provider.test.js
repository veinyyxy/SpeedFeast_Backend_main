const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createSmsProvider,
} = require('../public/out/warp_sms_sender/sms_provider_factory');
const {
  TwilioSmsProvider,
} = require('../public/out/warp_sms_sender/twilio_sms_provider');

const ACCOUNT_SID = `AC${'0'.repeat(32)}`;
const MESSAGING_SERVICE_SID = `MG${'1'.repeat(32)}`;

test('demo provider displays the verification message', async () => {
  const provider = createSmsProvider('demo');
  const originalLog = console.log;
  const output = [];
  console.log = (message) => output.push(message);

  try {
    const result = await provider.send({
      to: '+12045550100',
      body: 'Your verification code is: 1234',
    });

    assert.equal(result.provider, 'demo');
    assert.equal(result.status, 'displayed');
    assert.match(output[0], /1234/);
  } finally {
    console.log = originalLog;
  }
});

test('factory rejects an unsupported provider', () => {
  assert.throws(
    () => createSmsProvider('unsupported'),
    /Supported providers: demo, twilio/,
  );
});

test('twilio provider sends with a configured phone number', async () => {
  const provider = new TwilioSmsProvider({
    accountSid: ACCOUNT_SID,
    authToken: 'test-token',
    fromNumber: '+12045550101',
  });
  let request;
  provider.client.messages.create = async (value) => {
    request = value;
    return { sid: 'SM-test', status: 'queued' };
  };

  const result = await provider.send({
    to: '+12045550100',
    body: 'Verification code: 1234',
  });

  assert.deepEqual(request, {
    body: 'Verification code: 1234',
    to: '+12045550100',
    from: '+12045550101',
  });
  assert.equal(result.messageId, 'SM-test');
});

test('twilio provider prefers a Messaging Service SID', async () => {
  const provider = new TwilioSmsProvider({
    accountSid: ACCOUNT_SID,
    authToken: 'test-token',
    fromNumber: '+12045550101',
    messagingServiceSid: MESSAGING_SERVICE_SID,
  });
  let request;
  provider.client.messages.create = async (value) => {
    request = value;
    return { sid: 'SM-test', status: 'accepted' };
  };

  await provider.send({
    to: '+12045550100',
    body: 'Verification code: 1234',
  });

  assert.deepEqual(request, {
    body: 'Verification code: 1234',
    to: '+12045550100',
    messagingServiceSid: MESSAGING_SERVICE_SID,
  });
});
