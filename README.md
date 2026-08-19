# actual-helpers

Personal Actual Budget sync jobs (SimpleFin, Guideline, Plaid, Questrade, interest, Zestimate, Google Drive backup).

## Layout

```text
run.sh              cron entrypoint (HA notify on failure)
jobs/               simplefin, guideline, plaid, questrade, interest, zestimate, servicemac, finley, cadhome, backup
plaid/              Plaid Link CLI + UI
lib/actual.js       shared Actual helpers
data/               Questrade token files (gitignored)
_unused/            placeholders (kbb, rentcast, …)
example.env         env template
docker-compose.yml  Pi container
```

## Pi usage

```bash
./run.sh
docker exec actual-helpers node jobs/simplefin.js
docker exec actual-helpers node jobs/guideline.js
docker exec actual-helpers node jobs/plaid.js status
docker exec -it actual-helpers node jobs/plaid.js update "Guideline"
docker exec actual-helpers node jobs/questrade.js
docker exec actual-helpers node jobs/cadhome.js
```

```cron
0 5 * * * /home/cassandrameijers/actual-helpers/run.sh
```

Remove the old hourly backup and 1st-of-month interest crons once this is working:

```cron
# 0 * * * * /home/cassandrameijers/backups/backup-actual.sh
# 30 4 1 * * docker exec actual-helpers node jobs/interest.js >> /home/cassandrameijers/actual-helpers/interest.log 2>&1
```

On the Pi, use `ACTUAL_SERVER_URL=http://host.docker.internal:5006` so helpers skip Cloudflare on long syncs.

## Google Drive backup

Same approach as [actualbudget-backup](https://github.com/rodriguestiago0/actualbudget-backup): export a zip with `@actual-app/api`, then `rclone copy` to Drive. It runs at the end of `run.sh`.

The container uses the Pi’s existing rclone login (`~/.config/rclone/rclone.conf`, remote `gdrive`). After deploy:

```bash
docker exec actual-helpers rclone lsd gdrive:backups/actual
docker exec actual-helpers node jobs/backup.js
```

Zips land in Drive folder `backups/actual/` as `backup.<sync-id>.YYYYMMDD.zip`. Set `BACKUP_KEEP_DAYS` in `.env` (default 30).

## Browser SSH

Tunnel: `ssh.jassie.us` → `ssh://localhost:22`. Then Cloudflare Zero Trust → Access → Applications → Self-hosted → hostname `ssh.jassie.us` → browser rendering SSH → allow your email.

Open `https://ssh.jassie.us`. Cloudflare SSHs as the part before `@` in that email (must match the Pi username).

## Deploy

Push to `main` builds the image on GitHub, then the Pi’s self-hosted Actions runner runs `docker compose pull && up -d`.

## License

`LICENSE` covers upstream MIT code this fork is based on. Keep it even for personal use.
