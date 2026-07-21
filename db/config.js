const { buildPostgresConfig } = require('../services/runtime_config');

const pgsql_config = buildPostgresConfig(process.env);

module.exports = {
  pgsql_config,
};
