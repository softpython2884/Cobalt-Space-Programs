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

# ---------- 4. nginx (HTTP) : sert le jeu + défi ACME ----------
# Cette config de base permet à Let's Encrypt de valider le domaine ; elle est
# remplacée par la version HTTPS complète à l'étape 5 dès que le certificat existe.
echo "-- Configuration nginx…"
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
write_http_conf() {
  cat > /etc/nginx/sites-available/cobalt <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    root ${APP_DIR}/dist;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

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
}

# Config HTTPS complète, écrite PAR NOUS (plus de dépendance aux modifications
# de certbot --nginx : avant, chaque redéploiement écrasait le bloc SSL et le
# site perdait son HTTPS jusqu'au prochain coup de chance)
write_https_conf() {
  cat > /etc/nginx/sites-available/cobalt <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    # défi ACME (renouvellements du certificat)
    location /.well-known/acme-challenge/ {
        root ${APP_DIR}/dist;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;

    root ${APP_DIR}/dist;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

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
}

write_http_conf
ln -sf /etc/nginx/sites-available/cobalt /etc/nginx/sites-enabled/cobalt
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ---------- 5. SSL ----------
echo "-- Certificat SSL (Let's Encrypt)…"
if [ ! -e "${CERT_DIR}/fullchain.pem" ]; then
  # webroot : n'édite pas la config nginx, et le verrou certbot (« Another
  # instance is already running ») se retente au lieu de tuer le déploiement
  obtained=0
  for attempt in 1 2 3 4 5 6; do
    if certbot certonly --webroot -w "${APP_DIR}/dist" -d "$DOMAIN" \
      --non-interactive --agree-tos --register-unsafely-without-email \
      --deploy-hook "systemctl reload nginx"; then
      obtained=1
      break
    fi
    echo "   certbot indisponible (verrou ?) — nouvel essai dans 10 s (${attempt}/6)…"
    sleep 10
  done
  if [ "$obtained" = "0" ]; then
    echo "   ⚠ Échec de l'obtention du certificat. Si « Another instance of Certbot »"
    echo "     persiste, un processus est bloqué : pkill -f certbot ; puis relancez ./deploy.sh"
  fi
fi

if [ -e "${CERT_DIR}/fullchain.pem" ]; then
  echo "-- nginx : activation HTTPS…"
  write_https_conf
  nginx -t
  systemctl reload nginx
else
  echo "   ⚠ Pas de certificat pour l'instant — le site reste servi en HTTP."
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
