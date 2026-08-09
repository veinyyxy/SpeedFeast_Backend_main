const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { pool } = require('./pgsql');

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const filename of ['saas_control.sql', 'theme_config.sql']) {
      const sql = fs.readFileSync(path.join(__dirname, filename), 'utf8');
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log('SaaS control and theme migrations applied');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
