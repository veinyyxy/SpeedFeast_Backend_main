const { pgsql_config } = require('./config');
const { Pool } = require('pg');

const pool = new Pool(pgsql_config);

pool.on('error', () => {
  // Do not log the connection string, host, username or password.
  console.error('Unexpected error from an idle PostgreSQL client');
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
