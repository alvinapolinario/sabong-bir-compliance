#!/bin/bash
# Installs the BIR Compliance System on a fresh Ubuntu 24.04 VPS.
#
# Copy the project to the VPS (without node_modules, .env, keys/ and storage/),
# then from inside the project folder run:
#
#   sudo DOMAIN=bir.example.com EMAIL=admin@example.com bash deploy/setup-ubuntu.sh
#
# Safe to run again: existing database, .env and keys are kept.
set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN, e.g. DOMAIN=bir.example.com}"
EMAIL="${EMAIL:?Set EMAIL for the HTTPS certificate notices}"
APP=/opt/bir-compliance
SRC="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
. /etc/os-release; [ "$VERSION_ID" = "24.04" ] || echo "WARNING: written for Ubuntu 24.04 (this is $VERSION_ID)."

step() { printf '\n==> %s\n' "$*"; }

step "System packages"
apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -y -q mariadb-server nginx certbot python3-certbot-nginx \
  ufw fail2ban unattended-upgrades curl ca-certificates rsync gzip
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs
fi
echo "node $(node -v)"

step "Automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

step "Firewall: only SSH and web (80/443) are reachable"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable
systemctl enable --now fail2ban

step "Service user and application files"
id bircomp >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin bircomp
mkdir -p "$APP"
rsync -a --delete --exclude node_modules --exclude .env --exclude keys --exclude storage --exclude .sandbox-users \
  --exclude docker-compose.yml --exclude .git "$SRC"/ "$APP"/
mkdir -p "$APP/keys" "$APP/storage/packages"
cd "$APP"
chown -R root:bircomp "$APP"
chmod -R g-w,o-rwx "$APP"
chown -R bircomp:bircomp "$APP/keys" "$APP/storage"
chmod 700 "$APP/keys"; chmod 750 "$APP/storage" "$APP/storage/packages"
npm ci --omit=dev --no-audit --no-fund
chown -R root:bircomp "$APP/node_modules"; chmod -R o-rwx "$APP/node_modules"

step "Database"
systemctl enable --now mariadb
if [ ! -f "$APP/.env" ]; then
  DBPASS=$(openssl rand -hex 24)
  mariadb -e "CREATE DATABASE IF NOT EXISTS bir_compliance CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    CREATE USER IF NOT EXISTS 'bir_app'@'localhost' IDENTIFIED BY '$DBPASS';
    ALTER USER 'bir_app'@'localhost' IDENTIFIED BY '$DBPASS';
    GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER, LOCK TABLES ON bir_compliance.* TO 'bir_app'@'localhost';
    FLUSH PRIVILEGES;"
  cp "$APP/.env.example" "$APP/.env"
  sed -i "s|^NODE_ENV=.*|NODE_ENV=production|; s|^APP_URL=.*|APP_URL=https://$DOMAIN|; s|^DB_PASSWORD=.*|DB_PASSWORD=$DBPASS|; s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 48)|" "$APP/.env"
  chown root:bircomp "$APP/.env"; chmod 640 "$APP/.env"
  echo "Created $APP/.env and database user bir_app."
else
  echo "$APP/.env exists: kept."
fi
# MariaDB listens on localhost only (Ubuntu default); make sure.
grep -q '^bind-address' /etc/mysql/mariadb.conf.d/50-server.cnf && sed -i 's/^bind-address.*/bind-address = 127.0.0.1/' /etc/mysql/mariadb.conf.d/50-server.cnf

step "Schema"
sudo -u bircomp node scripts/migrate.js

step "Keys (kept if they already exist)"
sudo -u bircomp node scripts/keygen.js

step "Application service"
cp "$APP/deploy/bir-compliance.service" /etc/systemd/system/bir-compliance.service
systemctl daemon-reload
systemctl enable bir-compliance >/dev/null
systemctl restart bir-compliance
sleep 2; systemctl --no-pager --lines=3 status bir-compliance | head -5

step "nginx + HTTPS certificate for $DOMAIN"
sed "s/__DOMAIN__/$DOMAIN/g" "$APP/deploy/nginx-site.conf" > /etc/nginx/sites-available/bir-compliance
ln -sf /etc/nginx/sites-available/bir-compliance /etc/nginx/sites-enabled/bir-compliance
rm -f /etc/nginx/sites-enabled/default
sed -i 's/# server_tokens off;/server_tokens off;/' /etc/nginx/nginx.conf
nginx -t && systemctl reload nginx
certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive --redirect || \
  echo "WARNING: certificate not issued. Check that $DOMAIN points to this server, then run: certbot --nginx -d $DOMAIN --redirect"

step "Daily backups (02:30)"
install -m 700 "$APP/deploy/bir-backup.sh" /usr/local/sbin/bir-backup.sh
echo "30 2 * * * root /usr/local/sbin/bir-backup.sh >> /var/log/bir-backup.log 2>&1" > /etc/cron.d/bir-backup

cat <<EOF

============================================================
 Installed. Next steps:
 1. Create the first administrator:
      cd $APP && sudo -u bircomp node scripts/create-user.js --username admin --name "System Administrator" --role admin
 2. Register the betting server's signing key (from 'php artisan seal:keygen' on the betting server):
      cd $APP && sudo -u bircomp node scripts/register-server.js --server-id <SEAL_SERVER_ID> --name "Blueknife Gallera betting server" --public-key <base64>
 3. Put SEAL_VPS_PUBLIC_KEY (printed above) in the betting server's .env.
 4. Copy $APP/keys to sealed offline storage, and copy /var/backups/bir-compliance off this server regularly.
 5. Open https://$DOMAIN
============================================================
EOF
