module.exports = {
  apps: [
    {
      name: 'loki-backend',
      script: './backend/server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        LOKI_ALLOWED_ORIGINS: 'http://localhost:4173,http://127.0.0.1:4173',
        LOKI_TELEGRAM_BOT_TOKEN: '',
        LOKI_TELEGRAM_CHAT_ID: '',
        LOKI_PHISH_DB_PATH: '/opt/phishguard/data/phishguard.db',
        LOKI_STRESSE_PROXY: ''
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
        LOKI_ALLOWED_ORIGINS: 'http://localhost:4173,http://127.0.0.1:4173',
        LOKI_TELEGRAM_BOT_TOKEN: '',
        LOKI_TELEGRAM_CHAT_ID: '',
        LOKI_PHISH_DB_PATH: '/opt/phishguard/data/phishguard.db',
        LOKI_STRESSE_PROXY: ''
      }
    }
  ]
};
