module.exports = {
  apps: [
    {
      name: 'loki-backend',
      script: './backend/server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        LOKI_ALLOWED_ORIGINS: 'http://localhost:4173,http://127.0.0.1:4173'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
        LOKI_ALLOWED_ORIGINS: 'http://localhost:4173,http://127.0.0.1:4173'
      }
    },
    {
      name: 'loki-frontend',
      script: 'npm',
      args: 'run preview -- --host 0.0.0.0 --port 4173',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
