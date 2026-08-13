# actual-helpers

Personal Actual Budget sync jobs (SimpleFin, Plaid, Questrade, interest, Zestimate).

## Layout

```text
run.sh              cron entrypoint (HA notify on failure)
jobs/               simplefin, plaid, questrade, interest, zestimate
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
docker exec actual-helpers node jobs/plaid.js status
docker exec -it actual-helpers node jobs/plaid.js update "Guideline"
docker exec actual-helpers node jobs/questrade.js
```

```cron
0 5 * * * /home/cassandrameijers/actual-helpers/run.sh
30 4 1 * * docker exec actual-helpers node jobs/interest.js >> /home/cassandrameijers/actual-helpers/interest.log 2>&1
```

On the Pi, use `ACTUAL_SERVER_URL=http://host.docker.internal:5006` so helpers skip Cloudflare on long syncs.

## License

`LICENSE` covers upstream MIT code this fork is based on. Keep it even for personal use.
