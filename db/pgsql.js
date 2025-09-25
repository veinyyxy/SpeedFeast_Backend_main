const { pgsql_config } = require('./config');
const { Pool } = require('pg');

const pool = new Pool(pgsql_config);

module.exports = {
    query: (text, params) => pool.query(text, params, ), pool
};
