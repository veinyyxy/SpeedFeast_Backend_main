require('dotenv').config();
var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const cors = require('cors');
var app = express();


// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(logger('dev'));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

//app.use('/images', express.static(path.join(__dirname, 'images')));

// Enable CORS for requests from Flutter Web
app.use(cors({
  origin: '*', // Flutter Web 的端口
  credentials: true // 如果你有 cookie 或认证头
}));

// 给 /images 静态资源加 CORS
app.use('/images', cors({
  origin: '*',
  credentials: true
}), express.static(path.join(__dirname, 'images')));

// routes
app.use('/api', require('./routes/products.js'));
app.use('/api', require('./routes/verification.js'));
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
