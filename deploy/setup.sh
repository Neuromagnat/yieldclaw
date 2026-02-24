#!/bin/bash
# YieldClaw server setup for Ubuntu/Debian (Aeza VPS)
# Run as root: bash setup.sh

set -e

echo "=== Installing Node.js 20 ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git

echo "=== Installing nginx & certbot ==="
apt-get install -y nginx certbot python3-certbot-nginx

echo "=== Installing pm2 ==="
npm install -g pm2 typescript ts-node

echo "=== Setting up app directory ==="
mkdir -p /opt/yieldclaw
echo ""
echo "============================================"
echo "  Setup complete! Now do the following:"
echo "============================================"
echo ""
echo "1. Copy project files to server:"
echo "   scp -r ./* root@77.110.118.193:/opt/yieldclaw/"
echo ""
echo "2. On the server:"
echo "   cd /opt/yieldclaw"
echo "   npm install"
echo "   npx tsc"
echo "   cp .env.example .env"
echo "   nano .env          # set your keys"
echo ""
echo "3. Start with pm2:"
echo "   pm2 start dist/index.js --name yieldclaw"
echo "   pm2 startup"
echo "   pm2 save"
echo ""
echo "4. Setup nginx + SSL:"
echo "   cp deploy/nginx.conf /etc/nginx/sites-available/yieldclaw"
echo "   ln -s /etc/nginx/sites-available/yieldclaw /etc/nginx/sites-enabled/"
echo "   rm -f /etc/nginx/sites-enabled/default"
echo "   nginx -t && systemctl reload nginx"
echo "   certbot --nginx -d yieldclaw.live -d www.yieldclaw.live"
echo ""
echo "Done! Site will be at https://yieldclaw.live"
