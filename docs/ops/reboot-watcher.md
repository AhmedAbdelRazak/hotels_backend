# Jannat Reboot Watcher

Purpose: keep low-risk evidence for unexpected host reboots without touching the app runtime.

The watcher is installed on the production host as the `ahmedadmin` user, using that user's crontab. It runs:

- once at boot with `@reboot`
- every 3 minutes with `*/3 * * * *`

It writes only under:

```text
/home/ahmedadmin/ops/reboot-watcher
```

Important files:

```text
/home/ahmedadmin/ops/reboot-watcher/INSTALLED.md
/home/ahmedadmin/ops/reboot-watcher/logs/snapshots.tsv
/home/ahmedadmin/ops/reboot-watcher/logs/boot-evidence-*.log
/home/ahmedadmin/ops/reboot-watcher/state/last_boot_id
```

What it records:

- current boot ID
- uptime seconds
- load average
- available memory
- root disk usage
- `cloudflared` active state
- local backend health: `http://127.0.0.1:8080/api/aiagent/health`
- public backend health: `https://xhotelpro.com/api/aiagent/health`
- PM2 summary lines for the main services

When it detects a new OS boot ID, it also captures one evidence file with:

- reboot/shutdown history
- `journalctl --list-boots`
- previous boot warnings
- previous boot final journal lines
- kernel reboot/OOM/power/thermal indicators
- `cloudflared` logs around the previous and current boot
- memory, disk, network, DNS, sensors, and PM2 state

Useful commands:

```bash
crontab -l
tail -20 /home/ahmedadmin/ops/reboot-watcher/logs/snapshots.tsv
ls -lh /home/ahmedadmin/ops/reboot-watcher/logs/boot-evidence-*.log
sed -n '1,120p' /home/ahmedadmin/ops/reboot-watcher/INSTALLED.md
```

Install/update from the repo on the production host:

```bash
cd /home/ahmedadmin/Hotels/hotels_backend
bash scripts/ops/install-reboot-watcher.sh
```

This watcher does not restart services, edit app `.env` files, or require root privileges.
