require('dotenv').config();
var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const {
  buildCorsOptions,
  isProductionEnvironment,
  validateProductionEnvironment,
} = require('./services/runtime_config');
validateProductionEnvironment(process.env);
const { pool } = require('./db/pgsql');
/*const session = require('express-session');
const RedisStore = require('connect-redis').default;
const { createClient } = require('redis');*/

var app = express();
const isProduction = isProductionEnvironment(process.env);

if (isProduction) {
  // The public request passes through exactly one ALB/reverse proxy.
  app.set('trust proxy', 1);
}
/*const redisClient = createClient();
app.use(session({
  //store: new RedisStore({ client: redisClient }),
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));*/

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.disable('x-powered-by');
app.use(helmet({
  // Product images are intentionally consumed by the buyer and merchant origins.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(logger(isProduction ? 'combined' : 'dev'));
app.use(cookieParser());
app.use('/api/payments/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({
  verify(req, _res, buffer) {
    // Request signatures must be checked against the exact JSON bytes sent by
    // the client. Parsing and serializing again can change valid JSON such as
    // `12.0` to `12`, which produces a different HMAC.
    req.rawBody = Buffer.from(buffer);
  },
}));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

//app.use('/images', express.static(path.join(__dirname, 'images')));

// Browser origins are configured as a comma-separated production allowlist.
const corsOptions = buildCorsOptions(process.env);
app.use(cors(corsOptions));

// 给 /images 静态资源加 CORS
app.use('/images', cors(corsOptions), express.static(path.join(__dirname, 'images')));

// Liveness does not depend on external services.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness confirms that the API can reach PostgreSQL.
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ready' });
  } catch (_error) {
    res.status(503).json({ status: 'unavailable' });
  }
});

function positiveIntegerEnvironment(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: positiveIntegerEnvironment('API_RATE_LIMIT_PER_MINUTE', 600),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});
const authenticationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: positiveIntegerEnvironment('AUTH_RATE_LIMIT_PER_MINUTE', 20),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: 'Too many authentication attempts' },
});
const verificationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: positiveIntegerEnvironment('VERIFICATION_RATE_LIMIT_PER_MINUTE', 10),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: 'Too many verification attempts' },
});

app.use('/api', apiLimiter);
app.use('/api/users/login', authenticationLimiter);
app.use('/api/merchant/auth/login', authenticationLimiter);
app.use('/api/verification', verificationLimiter);

// routes
app.use('/api', require('./routes/products.js'));
app.use('/api', require('./routes/verification.js'));
app.use('/api', require('./routes/users.js'));
app.use('/api', require('./routes/orders.js'));
app.use('/api', require('./routes/dine_in.js'));
app.use('/api', require('./routes/reviews.js'));
app.use('/api', require('./routes/rewards.js'));
app.use('/api', require('./routes/payments.js'));
app.use('/api', require('./routes/config.js'));
app.use('/api', require('./routes/payment_methods.js'));
app.use('/api/buyer', require('./routes/buyer_notifications.js'));
app.use('/api/merchant', require('./routes/merchant_auth.js'));
app.use('/api/merchant', require('./routes/merchant_users.js'));
app.use('/api/merchant', require('./routes/merchant_dining_tables.js'));
app.use('/api/merchant', require('./routes/merchant_orders.js'));
app.use('/api/merchant', require('./routes/merchant_products.js'));
app.use('/api/merchant', require('./routes/merchant_rewards.js'));
app.use('/api/merchant', require('./routes/merchant_assets.js'));
app.use('/api/merchant', require('./routes/merchant_settings.js'));
app.use('/api/merchant', require('./routes/merchant_notifications.js'));
app.use('/api/merchant', require('./routes/merchant_print_jobs.js'));
// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
