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

echo "==> Nginx kuruluyor..."
apt install -y nginx

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

echo "==> CORS izinleri ayarlaniyor..."
# Sunucunun dis IP'sini bul ve frontend origin'ini ekle
SERVER_IP=$(hostname -I | awk '{print $1}')
ALLOWED="http://${SERVER_IP}:4173,http://localhost:4173,http://127.0.0.1:4173"
# Ecosystem dosyasindaki LOKI_ALLOWED_ORIGINS degerini guncelle
sed -i "s|LOKI_ALLOWED_ORIGINS: '.*'|LOKI_ALLOWED_ORIGINS: '${ALLOWED}'|" ecosystem.config.cjs

echo "==> Nginx yapilandiriliyor..."
rm -f /etc/nginx/sites-enabled/default
ln -sf ${APP_DIR}/nginx/loki.conf /etc/nginx/sites-enabled/loki.conf
nginx -t
systemctl restart nginx
systemctl enable nginx

echo "==> Eski pm2 surecleri durduruluyor..."
pm2 delete loki-backend 2>/dev/null || true
pm2 delete loki-frontend 2>/dev/null || true

echo "==> Backend baslatiliyor..."
pm2 start ecosystem.config.cjs --env production

echo "==> pm2 autostart ayarlaniyor..."
pm2 save
pm2 startup systemd -u root --hp /root

echo "==> Tamamlandi."
echo "Backend: http://${SERVER_IP}:3001"
echo "Frontend: http://${SERVER_IP}:4173"
