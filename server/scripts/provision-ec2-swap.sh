#!/usr/bin/env bash
# Adds a swap file to the 2GB Amazon Linux 2023 EC2 host so transient memory
# spikes (bulk imports, soffice conversions, reconnect storms) push to swap
# instead of tripping the OOM-killer / PM2 restart loop. Idempotent.
#
# Safe to re-run: skips if the swap file already exists, and never touches an
# existing swap device or file with a different path.
set -euo pipefail

SWAPFILE="${SWAPFILE:-/swapfile}"
SIZE_GB="${SWAP_SIZE_GB:-2}"
SWAPPINESS="${SWAP_SWAPPINESS:-10}"

if sudo swapon --show | awk '{print $1}' | grep -qx "${SWAPFILE}"; then
  echo "swap already active on ${SWAPFILE}"
else
  if [ -e "${SWAPFILE}" ]; then
    echo "ERROR: ${SWAPFILE} exists but is not an active swap file - handle manually." >&2
    exit 1
  fi
  echo "creating ${SIZE_GB}G swap file at ${SWAPFILE}..."
  sudo fallocate -l "${SIZE_GB}G" "${SWAPFILE}"
  sudo chmod 600 "${SWAPFILE}"
  sudo mkswap "${SWAPFILE}"
  sudo swapon "${SWAPFILE}"
fi

# Persist across reboots (guard against duplicate fstab entries when re-run).
if ! grep -q "^${SWAPFILE} " /etc/fstab 2>/dev/null; then
  echo "${SWAPFILE} none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
fi

# Swap sparingly: the OS should prefer to drop caches and compact memory
# before paging, since the DB is remote (RDS) and swap I/O on gp3 EBS is slow.
sudo sysctl -w vm.swappiness="${SWAPPINESS}"
if ! grep -q "^vm.swappiness=" /etc/sysctl.d/99-ucs-crm.conf 2>/dev/null; then
  sudo tee /etc/sysctl.d/99-ucs-crm.conf >/dev/null <<EOF
vm.swappiness=${SWAPPINESS}
EOF
fi

echo "---- swap status ----"
free -h
sudo swapon --show