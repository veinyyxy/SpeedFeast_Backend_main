const env = process.env.NODE_ENV || 'dev';

let pgsql_config

if(env === 'dev'){
    pgsql_config = {
        user: 'postgres',
        host: 'localhost',
        database: 'SpeedFeastMain',
        password: '1234qwer',
        port: 5432
    }
};

module.exports = {
    pgsql_config
};