# Blueknife Gallera · BIR Compliance System

Receives the sealed, signed and encrypted **event closing packages** produced by the onsite
betting server, verifies them, stores them permanently, and gives the **Treasury Office** and
**Accounting** per-event and monthly reports for tax purposes.

Node.js 22 · Express · MariaDB · behind nginx with HTTPS on Ubuntu 24.04.

Companion system: **[on-cockpit-betting-station](https://github.com/alvinapolinario/on-cockpit-betting-station)**
(the offline betting server at the arena that produces the packages).

```
Betting server (offline, at the arena)          Upload laptop            This system (VPS)
Close & seal event → print & sign report
Download encrypted package (.pkg.enc)  ──LAN──►  save file  ──HTTPS──►  Upload package
                                                                         ├ decrypt (only this VPS can)
                                                                         ├ verify signature, hash, seal code
                                                                         ├ verify sequence chain (no gaps, no replays)
                                                                         ├ re-check the arithmetic
                                                                         └ store write-once → acknowledgment code
Enter acknowledgment code  ◄───────────────────────────────  ACK-S0001-xxxx-xxxx-xxxx
```

## Contents

1. [Roles and protections](#1-roles-and-protections)
2. [First-time deployment on the VPS](#2-first-time-deployment-on-the-vps)
3. [Connecting the betting server](#3-connecting-the-betting-server)
4. [Operating it](#4-operating-it)
5. [Updating to a new version](#5-updating-to-a-new-version)
6. [Backups, off-site copies and restore](#6-backups-off-site-copies-and-restore)
7. [Keys: backup, loss and replacement](#7-keys-backup-loss-and-replacement)
8. [Rolling back](#8-rolling-back)
9. [Troubleshooting](#9-troubleshooting)
10. [Local sandbox (development)](#10-local-sandbox-development)
11. [Docker reference: database, ports and credentials](#11-docker-reference-database-ports-and-credentials)

---

## 1. Roles and protections

| Role | Can |
|---|---|
| **Administrator** | Everything: users, tax rules, betting-server keys, audit trail |
| **Accounting** | Upload packages; view all events, monthly reports, CSV export, upload log |
| **Treasury Office** | Read-only: events, monthly reports, printing, CSV export, tax rules, audit trail |

- Only packages from a **registered** betting server (Ed25519 signature) are accepted; only this VPS can read them (X25519 encryption).
- **Sequence chain:** each package names the previous one; missing, replaced or re-used packages are rejected.
- **Write-once:** database triggers block editing or deleting packages, event reports, upload records and the audit log, even for the database root user.
- **Hash-chained audit trail**, re-verified on the Audit page.
- **Tax rates are never hard-coded:** rules name their legal basis and effective dates, and are retired, never edited.
- Live and **Legacy** (reconstructed from old backups) senders are kept apart and labelled.

## 2. First-time deployment on the VPS

### 2.1 Before you start
- A VPS with **Ubuntu 24.04 LTS**, SSH access with a sudo user, and at least 1 GB RAM.
- A **domain name** whose DNS **A record** points to the VPS IP (needed for the HTTPS certificate), e.g. `bir.yourdomain.ph`.
- An e-mail address for certificate notices.
- Enable **two-factor login on the VPS provider account** (its console is full control of the server).

### 2.2 Get the code
The repository is private. On the VPS create an SSH key and add it as a read-only **Deploy key**
(GitHub → repository → Settings → Deploy keys):
```bash
ssh-keygen -t ed25519 -C "bir-vps deploy key" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub        # paste into GitHub → Deploy keys (read-only)
git clone git@github.com:alvinapolinario/sabong-bir-compliance.git ~/sabong-bir-compliance
```

### 2.3 Run the installer
```bash
cd ~/sabong-bir-compliance
sudo DOMAIN=bir.yourdomain.ph EMAIL=you@yourdomain.ph bash deploy/setup-ubuntu.sh
```
The installer (safe to run again) does all of this:

| Step | Result |
|---|---|
| Packages | MariaDB, nginx, Node.js 22, certbot, ufw, fail2ban, unattended-upgrades |
| Firewall | only SSH and web (80/443) reachable; fail2ban against password guessing |
| Service user | `bircomp` (no login shell); app installed in `/opt/bir-compliance` |
| Database | `bir_compliance` + user `bir_app` with a generated password, local connections only |
| Configuration | `/opt/bir-compliance/.env` generated (`APP_URL=https://<domain>`, random secrets) |
| Schema | tables and write-once triggers (`scripts/migrate.js`) |
| **Keys** | **new** VPS keys in `/opt/bir-compliance/keys/`; prints `SEAL_VPS_PUBLIC_KEY=…` |
| Service | systemd unit `bir-compliance` (hardened, restarts automatically) |
| nginx + HTTPS | site for your domain + Let's Encrypt certificate, HTTP redirected to HTTPS |
| Backups | daily 02:30 to `/var/backups/bir-compliance` (60 days) |

**Write down the `SEAL_VPS_PUBLIC_KEY=` line it prints**; the betting server needs it.

### 2.4 First administrator and users
```bash
cd /opt/bir-compliance
sudo -u bircomp node scripts/create-user.js --username admin --name "System Administrator" --role admin
```
Sign in at `https://<domain>` → *Users* → add Accounting and Treasury Office accounts
(passwords: at least 10 characters with letters and numbers). Five failed sign-ins lock an account for 15 minutes.

### 2.5 Back up the keys
Copy `/opt/bir-compliance/keys/` to **two encrypted USB drives stored in a safe**.
Without `vps-enc.key`, uploaded packages can no longer be opened.
```bash
sudo tar -C /opt/bir-compliance -czf ~/bir-keys-$(date +%F).tgz keys   # then move it off the VPS and delete it here
```

### 2.6 Check
- `https://<domain>` shows the sign-in page with a valid certificate.
- `sudo systemctl status bir-compliance` → active (running).
- `sudo ufw status` → only OpenSSH and Nginx Full allowed.

## 3. Connecting the betting server

Two public keys are exchanged once; private keys never leave their machine.

1. **VPS → betting server:** put the `SEAL_VPS_PUBLIC_KEY=…` line (printed by the installer; re-show it with
   `sudo -u bircomp node scripts/keygen.js`, which keeps existing keys) in the **betting server's** `.env`,
   then restart its app container.
2. **Betting server → VPS:** on the betting server run `artisan seal:keygen` once; it prints its public key.
   Register it here with the betting server's `SEAL_SERVER_ID`:
   ```bash
   cd /opt/bir-compliance && sudo -u bircomp node scripts/register-server.js \
     --server-id blueknife-srv01 --name "Blueknife Gallera betting server" --kind live --public-key <base64>
   ```
3. (Only if past events will be imported) register the betting server's **legacy** key the same way with
   `--kind legacy` and the legacy sender id (default `blueknife-legacy`).
4. Check under *Betting servers*: the server is listed as **active**.

## 4. Operating it

- **After each event (Accounting):** *Upload package* → choose the `.pkg.enc` file → compare the **seal code**
  with the closing report signed at the arena → give the **acknowledgment code** to the arena admin, who enters it on the betting server.
- **Printing:** *Events* → *Print* (closing report layout, A4 landscape; "Save as PDF" keeps a copy).
- **Monthly (Treasury / Accounting):** *Monthly report* → choose the month → *Print report* or *Download CSV*.
- **Tax rules (Administrator):** add a rule only after the Treasury Office confirms the tax base, rate and ordinance.
- **Revoking a betting server** (lost or stolen server/key): *Betting servers* → *Revoke key*. Accepted packages stay valid.
- **Service commands:** `sudo systemctl status|restart bir-compliance` · logs: `sudo journalctl -u bir-compliance -f`.

## 5. Updating to a new version

```bash
sudo /usr/local/sbin/bir-backup.sh                 # safety backup first
cd ~/sabong-bir-compliance && git pull
sudo DOMAIN=bir.yourdomain.ph EMAIL=you@yourdomain.ph bash deploy/setup-ubuntu.sh
sudo systemctl status bir-compliance
```
The installer keeps `.env`, the database, keys and uploaded packages; it re-applies migrations and restarts the service.

## 6. Backups, off-site copies and restore

Daily at 02:30, `/usr/local/sbin/bir-backup.sh` writes to `/var/backups/bir-compliance/`:
`db-<date>.sql.gz` (database) and `packages-<date>.tar.gz` (original uploaded packages); 60 days are kept.
Run it by hand any time: `sudo /usr/local/sbin/bir-backup.sh`.

**Off-site copies are required** (a backup on the same VPS is lost with the VPS). For example, from an office computer:
```bash
rsync -av --rsync-path="sudo rsync" user@VPS:/var/backups/bir-compliance/ ~/bir-backups/
```
(the backup folder is readable by root only, hence `sudo rsync` on the VPS side; `user` needs sudo rights).

**Restore** onto a fresh or broken VPS:
1. Run the installer (section 2.3), then stop the service: `sudo systemctl stop bir-compliance`.
2. Put the **original keys** back: `sudo tar -C /opt/bir-compliance -xzf bir-keys-<date>.tgz && sudo chown -R bircomp:bircomp /opt/bir-compliance/keys && sudo chmod 700 /opt/bir-compliance/keys`.
3. Database:
   ```bash
   sudo mariadb -e "DROP DATABASE bir_compliance; CREATE DATABASE bir_compliance CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
   gunzip -c db-<date>.sql.gz | sudo mariadb bir_compliance
   ```
4. Packages: `sudo tar -C /opt/bir-compliance/storage -xzf packages-<date>.tar.gz && sudo chown -R bircomp:bircomp /opt/bir-compliance/storage`.
5. `sudo systemctl start bir-compliance`; sign in and open *Audit trail* (the chain must be intact).

## 7. Keys: backup, loss and replacement

| Key (in `/opt/bir-compliance/keys/`) | Used for | If lost |
|---|---|---|
| `vps-enc.key` | decrypting uploaded packages | packages already stored stay readable in the database; **new** packages encrypted to the old key cannot be opened. Generate a new key and give the new `SEAL_VPS_PUBLIC_KEY` to the betting server |
| `vps-sign.key` | signing acknowledgments | generate a new one; old acknowledgments remain valid |

To replace a key: move the old file aside, run `sudo -u bircomp node scripts/keygen.js` (creates only missing keys),
restart the service, and update the betting server's `.env` if the encryption key changed.

## 8. Rolling back

```bash
cd ~/sabong-bir-compliance
git log --oneline                         # find the previous version
git checkout <commit>
sudo DOMAIN=bir.yourdomain.ph EMAIL=you@yourdomain.ph bash deploy/setup-ubuntu.sh
```
Stored packages, reports and the audit trail are write-once and are not affected by a rollback.
Return to the latest version with `git checkout main && git pull` and run the installer again.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| Certificate not issued | DNS A record must point to the VPS; then `sudo certbot --nginx -d <domain> --redirect` |
| Site down (502) | `sudo systemctl status bir-compliance` and `sudo journalctl -u bir-compliance -n 50` |
| Upload rejected: "not encrypted for this system" | The betting server's `SEAL_VPS_PUBLIC_KEY` is not this VPS's key |
| Upload rejected: "not registered" | Register the betting server's key (section 3) |
| Upload rejected: "missing package S000x" | Upload the earlier packages first, in order |
| Upload rejected: "CONFLICT … different contents" | Stop: the same sequence number was already accepted with other data (tampering or a restored betting server). Investigate before continuing |
| Account locked | Wait 15 minutes, or an administrator disables/enables the account |
| Audit trail "chain BROKEN" | The database was edited outside the application; report it immediately |

## 10. Local sandbox (development)

```bash
cp .env.example .env          # set NODE_ENV=development, APP_URL=http://localhost:8090, random DB_PASSWORD,
                              # SESSION_SECRET and DB_ROOT_PASSWORD
docker compose up -d          # http://localhost:8090 (MariaDB + Node, this computer only)
docker exec bir-app node scripts/keygen.js
docker exec bir-app node scripts/create-user.js --username admin --name "Admin" --role admin
```
To test with the betting sandbox, import its stand-in key instead of generating one:
`docker exec bir-app node scripts/keygen.js --import-enc-keypair <base64 of storage/app/keys/vps-test.key>`.
Never use sandbox keys in production.

## 11. Docker reference: database, ports and credentials

> **Docker is for local testing only.** On the VPS the app runs under systemd with a native
> MariaDB (see [section 2](#2-first-time-deployment-on-the-vps)). The production values are
> listed in [11.5](#115-production-on-the-vps-for-comparison). Real passwords never go in this
> README or in git.

### 11.1 Containers

| Service | Container name | Image | Role |
|---|---|---|---|
| `db` | `bir-db` | `mariadb:11.4` | database (time zone `Asia/Manila`) |
| `app` | `bir-app` | `node:22-bookworm-slim` | on each start runs `npm install`, then `scripts/migrate.js`, then `src/server.js` |

### 11.2 Database

| Item | Value | `.env` setting |
|---|---|---|
| Engine | MariaDB 11.4 | n/a |
| Database name | `bir_compliance` | `DB_NAME` |
| Application user | `bir_app` | `DB_USER` |
| Application user password | your random value (`openssl rand -hex 24`) | `DB_PASSWORD` |
| MariaDB `root` password | a **separate** random value | `DB_ROOT_PASSWORD` (Docker only) |
| Host (from the app container) | `db` (forced by `docker-compose.yml`; overrides `.env`) | `DB_HOST` |
| Port inside Docker | `3306` | `DB_PORT` |
| Port on your computer | **not published** (reach it through the container) | n/a |
| Data volume | `bir-db` (plus `bir-node-modules` for `node_modules`) | n/a |
| Tables and write-once triggers | created by `scripts/migrate.js` on every app start (safe to re-run) | n/a |

> `docker-compose.yml` has **no defaults**. `DB_NAME`, `DB_USER`, `DB_PASSWORD` and
> `DB_ROOT_PASSWORD` must be filled in `.env` before the first `docker compose up`, or the
> database container will not initialise. Replace every `change-me`.

**Connecting to the database**
```bash
docker exec -it bir-db mariadb -u bir_app -p bir_compliance
docker exec -it bir-db mariadb -u root -p              # DB_ROOT_PASSWORD
```
To use a desktop tool, temporarily add under the `db` service in `docker-compose.yml`:
```yaml
    ports:
      - "127.0.0.1:3310:3306"
```
Then connect to `127.0.0.1:3310`. Do not commit this change.

### 11.3 Ports

| Host port | Container port | `.env` setting | Used for |
|---|---|---|---|
| `127.0.0.1:8090` | `8090` | `PORT` | web app: `http://localhost:8090` (this computer only) |
| none | `3306` | `DB_PORT` | MariaDB (Docker network only) |

Inside Docker the app listens on `0.0.0.0` (set in `docker-compose.yml`; overrides `HOST` in `.env`).
Keep `PORT=8090`, because the port mapping is fixed at `8090`.

### 11.4 Other related settings

| Setting | Value |
|---|---|
| `NODE_ENV` | `development` for the sandbox |
| `APP_URL` | `http://localhost:8090` for the sandbox |
| `SESSION_SECRET` | `openssl rand -hex 48` |
| `SESSION_HOURS` | `8` |
| `KEY_PATH` | `./keys` (`vps-enc.key`, `vps-sign.key`; created by `node scripts/keygen.js`) |
| `PACKAGE_PATH` | `./storage/packages` (uploaded packages) |
| `MAX_UPLOAD_MB` | `20` |

> The database credentials are applied **only when the `bir-db` volume is first created**.
> To start again with new credentials: `docker compose down -v` (this **deletes all sandbox data**),
> edit `.env`, then `docker compose up -d`.

### 11.5 Production on the VPS (for comparison)

| Item | Value |
|---|---|
| Database | native MariaDB on the VPS, database `bir_compliance`, user `bir_app` |
| Host / port | `127.0.0.1` / `3306` (local connections only; firewall allows only 22, 80, 443) |
| Password | generated by `deploy/setup-ubuntu.sh`; read it with `sudo grep DB_PASSWORD /opt/bir-compliance/.env` |
| App | `127.0.0.1:8090` behind nginx (HTTPS on 443) |
| Config / keys | `/opt/bir-compliance/.env` · `/opt/bir-compliance/keys/` |
| Backups | `/var/backups/bir-compliance` (daily 02:30, kept 60 days) |
