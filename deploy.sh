#!/usr/bin/env bash
# ============ COBALT SECTOR — déploiement machine dédiée ============
# Installe et configure tout pour servir le jeu sur https://cobalt.forgenet.fr
#   - nginx : sert le client buildé (dist/) + proxy WebSocket /ws -> :17771
#   - pm2   : garde le serveur de jeu en vie (redémarrage auto, boot)
#   - certbot : certificat SSL Let's Encrypt
#
# Usage (Ubuntu/Debian, depuis la racine du repo) :
#   chmod +x deploy.sh && sudo ./deploy.sh
#
# Prérequis : le DNS de cobalt.forgenet.fr pointe déjà vers cette machine.
set -euo pipefail

DOMAIN="cobalt.forgenet.fr"
PORT=17771
APP_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "== COBALT SECTOR — déploiement sur ${DOMAIN} =="
echo "   Dossier : ${APP_DIR}"

# ---------- 1. Dépendances système ----------
echo "-- Installation des paquets (nginx, certbot)…"
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx curl >/dev/null

if ! command -v node >/dev/null 2>&1; then
  echo "-- Node.js absent : installation (NodeSource 20.x)…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs >/dev/null
fi
echo "   Node $(node -v), npm $(npm -v)"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "-- Installation de pm2…"
  npm install -g pm2 >/dev/null
fi

# ---------- 2. Build du jeu ----------
echo "-- npm ci + build du client…"
cd "$APP_DIR"
npm ci
npm run build

echo "-- Bundle du serveur de jeu…"
npx esbuild server/server.ts --bundle --platform=node --format=cjs \
  --outfile=server/.server.cjs --external:ws

# ---------- 3. pm2 : le serveur de jeu tourne pour toujours ----------
echo "-- Démarrage sous pm2…"
pm2 delete cobalt >/dev/null 2>&1 || true
PORT=$PORT pm2 start server/.server.cjs --name cobalt --time
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

# ---------- 4. nginx : statique + proxy WebSocket ----------
echo "-- Configuration nginx…"
cat > /etc/nginx/sites-available/cobalt <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    root ${APP_DIR}/dist;
    index index.html;

    # Client du jeu (fichiers buildés)
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # WebSocket du serveur de jeu
    location /ws {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/cobalt /etc/nginx/sites-enabled/cobalt
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ---------- 5. SSL ----------
echo "-- Certificat SSL (Let's Encrypt)…"
if certbot certificates 2>/dev/null | grep -q "$DOMAIN"; then
  echo "   Certificat déjà présent — renouvellement géré par certbot."
else
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email --redirect
fi

# ---------- 6. Pare-feu (si ufw actif) ----------
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 'Nginx Full' >/dev/null || true
fi

echo ""
echo "== Terminé ! =="
echo "   Jeu      : https://${DOMAIN}"
echo "   Serveur  : pm2 status / pm2 logs cobalt"
echo "   Redéployer après un git pull : sudo ./deploy.sh (idempotent)"
