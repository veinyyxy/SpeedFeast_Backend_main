const StripePaymentProvider = require('./stripe_provider');

const providers = {
  stripe: new StripePaymentProvider(),
};

function getPaymentProvider(name) {
  const normalized = (name || process.env.PAYMENT_PROVIDER || 'stripe')
    .toString()
    .trim()
    .toLowerCase();
  const provider = providers[normalized];
  if (!provider) {
    throw new Error(`Unsupported payment provider: ${normalized}`);
  }
  return provider;
}

module.exports = {
  getPaymentProvider,
};
