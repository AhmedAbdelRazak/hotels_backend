# Jannat reboot incident - 2026-08-03

## Status

Resolved with a headless Intel i915 workaround. Jannat and the public applications were healthy after the controlled reboot.

## Incident summary

The `jannat` home server had been freezing or restarting unexpectedly. The main concern was that PM2 logs, cron jobs, backups, or application load were overwhelming the host.

The audit found that those were not the cause:

- Watcher data immediately before failures showed low load, more than 11 GiB available memory, 9% root-disk usage, and healthy local/public HTTP checks.
- There were no OOM kills, kernel panics, critical temperatures, storage I/O failures, NVMe media errors, watchdog reboots, root cron reboots, or PM2 restart storms.
- PM2 log rotation was active. Database backups used `flock` and completed in roughly two seconds.
- Previous journals repeatedly stopped abruptly instead of recording a normal shutdown.

The consistent warning immediately before the freezes was:

```text
workqueue: i915_hpd_poll_init_work [i915] hogged CPU for >10000us
```

This matched the behavior described in [Ubuntu Launchpad bug 1939347](https://bugs.launchpad.net/ubuntu/+source/linux/+bug/1939347) for a headless Coffee Lake system. The most likely cause was therefore an Intel i915 headless graphics-driver freeze.

## Changes made

1. Installed `/etc/modprobe.d/blacklist-i915-jannat-headless.conf` with `blacklist i915`.
2. Rebuilt all installed initramfs images and performed a controlled reboot.
3. Preserved a rollback backup at `/var/backups/jannat-i915-headless/20260803T151241Z`.
4. Preserved the privileged hardware/system audit at `/home/ahmedadmin/ops/root-audit/20260803T151241Z`.
5. Removed the reboot watcher's `@reboot` PM2 race. The watcher now runs every three minutes and refuses to query PM2 unless its existing RPC socket is present.
6. Removed one idle duplicate PM2 daemon created by that old race. The systemd-owned PM2 process and applications were not interrupted.
7. Removed NUL corruption left in the watcher history by old hard shutdowns. Its backup is `/home/ahmedadmin/ops/reboot-watcher/logs/snapshots.tsv.pre-null-clean-20260803T152447Z`.

The guarded recovery/rollback command remains installed at:

```text
/home/ahmedadmin/ops/jannat-i915-headless-fix.sh
```

## Verification after the fix

- `i915` was absent from `lsmod`.
- The current boot contained zero `i915_hpd_poll_init_work` warnings.
- PM2, nginx, and cloudflared were active with zero failed systemd units.
- All nine PM2 applications and `pm2-logrotate` were online with zero restarts.
- Jannat Booking, rooms, AI health, Zad Hotels, and XHotelPro returned HTTP 200.
- Local backend, currency, Zad scope, frontend, SSR, and Socket.IO checks passed.
- Root disk usage was 9%, swap usage was 0%, CPU temperature was about 39 C, and NVMe temperature was about 44 C.

## Hardware baseline

The Samsung NVMe passed SMART and its short self-test. It had 3% wear, zero media/data-integrity errors, and no critical warning.

At the end of this incident:

```text
Unsafe Shutdowns: 571
Power Cycles: 881
```

If `Unsafe Shutdowns` rises after a supposedly clean reboot, investigate the power adapter, cable, outlet/UPS, and motherboard.

## If the problem happens again

Do not unplug the server unless it is completely unresponsive. Record the time and whether power was physically removed. After access returns, preserve the previous boot before rebooting again:

```bash
cat /proc/sys/kernel/random/boot_id
uptime -s
journalctl --list-boots --no-pager
journalctl -b -1 --no-pager | tail -300
journalctl -k -b -1 --no-pager | grep -Eai 'i915|panic|watchdog|oom|I/O error|nvme.*(timeout|reset)|MCE|EDAC|hardware error'
tail -20 /home/ahmedadmin/ops/reboot-watcher/logs/snapshots.tsv
ls -lht /home/ahmedadmin/ops/reboot-watcher/logs/boot-evidence-*.log | head
```

Confirm the workaround is still active:

```bash
grep -F 'blacklist i915' /etc/modprobe.d/blacklist-i915-jannat-headless.conf
lsmod | grep '^i915' || true
journalctl -k -b --no-pager | grep -Fc 'i915_hpd_poll_init_work' || true
```

Before using PM2, confirm its socket exists so a second daemon is not created:

```bash
systemctl is-active pm2-ahmedadmin nginx cloudflared
test -S /home/ahmedadmin/.pm2/rpc.sock && timeout 8s pm2 ls --no-color
systemctl --failed --no-pager
```

If the host reboots while i915 is still blacklisted and absent, treat it as a new power or hardware incident rather than repeatedly applying the same fix. Compare the NVMe unsafe-shutdown count with `571` and inspect power delivery first.

## Rollback

The workaround disables the Intel graphics driver and is intended only while Jannat remains headless. If a local display or GPU functionality becomes necessary, use a maintenance window and run:

```bash
sudo /home/ahmedadmin/ops/jannat-i915-headless-fix.sh rollback-and-reboot
```

Do not live-load i915 on the production host.
