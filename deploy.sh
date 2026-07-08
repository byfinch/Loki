#!/bin/bash
set -e

# Loki Panel - Ubuntu 24.04 Deploy Scripti
# Bu script sunucuya atildiktan sonra root olarak calistirilir.

# Scriptin bulundugu dizini uygulama dizini olarak al
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$SCRIPT_DIR

echo "==> Sistem guncelleniyor..."
apt update && apt upgrade -y

echo "==> Node.js 20 kuruluyor..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

echo "==> pm2 kuruluyor..."
npm install -g pm2

echo "==> Uygulama dizini hazirlaniyor..."
cd $APP_DIR

echo "==> Backend bagimliliklari kuruluyor..."
cd backend
npm install
npm install -g nodemon 2>/dev/null || true
cd ..

echo "==> Frontend bagimliliklari kuruluyor ve build aliniyor..."
npm install
npm run build

echo "==> Eski pm2 surecleri durduruluyor..."
pm2 delete loki-backend 2>/dev/null || true
pm2 delete loki-frontend 2>/dev/null || true

echo "==> Backend baslatiliyor..."
pm2 start backend/server.js --name loki-backend --env-file /etc/default/loki-backend

echo "==> Frontend baslatiliyor..."
pm2 start npm --name loki-frontend -- run preview -- --host 0.0.0.0 --port 4173

echo "==> CORS izinleri ayarlaniyor..."
# Sunucunun dis IP'sini bul ve frontend origin'ini env degiskeni olarak ayarla
SERVER_IP=$(hostname -I | awk '{print $1}')
export LOKI_ALLOWED_ORIGINS="http://${SERVER_IP}:4173"
# Kalici hale getir: pm2 env dosyasina yaz
echo "LOKI_ALLOWED_ORIGINS=${LOKI_ALLOWED_ORIGINS}" > /etc/default/loki-backend
chmod 600 /etc/default/loki-backend

echo "==> pm2 autostart ayarlaniyor..."
pm2 save
pm2 startup systemd -u root --hp /root

echo "==> Tamamlandi."
echo "Backend: http://$(hostname -I | awk '{print $1}'):3001"
echo "Frontend: http://$(hostname -I | awk '{print $1}'):4173"
