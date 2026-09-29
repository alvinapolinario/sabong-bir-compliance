# Blueknife Gallera · BIR Compliance System

Receives the sealed, signed and encrypted **event closing packages** produced by the
onsite betting server, verifies them, stores them permanently, and gives the
**Treasury Office** and **Accounting** per-event and monthly reports for tax purposes.

Node.js 22 · Express · MariaDB · runs behind nginx with HTTPS on Ubuntu 24.04.

## How it fits together

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

## Roles

| Role | Can |
|---|---|
| **Administrator** | Everything: users, tax rules, betting server keys, audit trail |
| **Accounting** | Upload packages; view all events, monthly reports, CSV export, upload log |
| **Treasury Office** | Read-only: events, monthly reports, CSV export, tax rules, audit trail |

## What protects the records

- **Only packages from a registered betting server** (Ed25519 signature) are accepted.
- **Only this VPS can read a package** (encrypted to its X25519 key).
- **Sequence chain:** each package names the previous one; missing, replaced or re-used packages are rejected.
- **Write-once:** database triggers block editing or deleting packages, event reports, upload records and the audit log, even for the database root user.
- **Hash-chained audit trail** of sign-ins, uploads, views, exports and settings changes; the Audit page re-verifies the chain.
- The original uploaded files are also kept read-only in `storage/packages/`.
- **Tax rates are never hard-coded.** Rules name their legal basis and effective dates, and are retired, never edited or deleted.

## Install on the VPS (Ubuntu 24.04)

1. Point the domain's DNS (A record) at the VPS.
2. Copy this folder to the VPS **without** `node_modules/`, `.env`, `keys/`, `storage/` or `.sandbox-users`, e.g.
   ```bash
   rsync -av --exclude node_modules --exclude .env --exclude keys --exclude storage --exclude .sandbox-users ./ user@VPS:bir-compliance/
   ```
3. On the VPS:
   ```bash
   cd bir-compliance && sudo DOMAIN=bir.yourdomain.ph EMAIL=you@yourdomain.ph bash deploy/setup-ubuntu.sh
   ```
   This installs MariaDB, Node 22, nginx, a Let's Encrypt certificate, the firewall (SSH + web only),
   fail2ban, automatic security updates, the service and daily backups, and **generates new VPS keys**.
4. Create the first administrator (the script prints the exact command), then sign in and add the other users.
5. Register the betting server's key. On the **betting server**: `php artisan seal:keygen` (once) prints its public key. On the **VPS**:
   ```bash
   cd /opt/bir-compliance && sudo -u bircomp node scripts/register-server.js \
     --server-id <SEAL_SERVER_ID from the betting server> --name "Blueknife Gallera betting server" --public-key <base64>
   ```
6. On the **betting server**, set `SEAL_VPS_PUBLIC_KEY=` to the value the installer printed.
7. **Back up `/opt/bir-compliance/keys` to sealed offline storage.** Without `vps-enc.key`, packages cannot be opened.

## Operating it

- **After each event (Accounting):** Upload package → compare the **seal code** with the signed paper report → type the **acknowledgment code** into the betting server's Closing Reports page.
- **Monthly (Treasury / Accounting):** Monthly report → choose the month → print (Ctrl+P) or Download CSV.
- **Tax rules (Administrator):** add a rule only after the Treasury Office confirms the tax base, rate and ordinance.
- **Service:** `sudo systemctl status|restart bir-compliance` · logs: `journalctl -u bir-compliance`.
- **Backups:** daily 02:30 to `/var/backups/bir-compliance` (database + original packages, 60 days).
  **Copy them off the VPS regularly.**

## Updating

Copy the new version to the VPS and run the installer again. It keeps `.env`, the database, keys and packages,
re-applies migrations and restarts the service.

## Local testing (sandbox)

```bash
docker compose up -d          # http://localhost:8090 (MariaDB + Node, this Mac only)
```
The sandbox imports the betting sandbox's stand-in VPS key so its test packages decrypt; test user
passwords are in `.sandbox-users` (not for production).
