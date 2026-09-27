#!/bin/bash
# scoped.sh CMD...: runs CMD in a transient systemd scope whose memory is
# capped at 85% of the machine's, as a backstop to the per-cell watchdog.
#
# Without it, a process that outruns the watchdog exhausts the machine; on
# a GitHub runner that shuts the runner down, and every later step of the
# job is skipped, so nothing (not even partial results) is uploaded. With
# it, the kernel kills inside the scope, the step fails like any other, and
# the always() steps still run.
#
# It tries a user scope (no privileges, where a user manager runs), then a
# system scope through passwordless sudo that drops back to this user, and
# otherwise runs CMD as is. Each is probed with `true` first.
set -u
max=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0) * 85 / 100 ))
props=(-p "MemoryMax=${max}K" -p MemorySwapMax=0 -p TasksMax=16384)
if [ "$max" -gt 0 ] && command -v systemd-run >/dev/null 2>&1; then
  if systemd-run --user --scope --quiet "${props[@]}" true >/dev/null 2>&1; then
    echo "scoped.sh: user scope, MemoryMax=$((max / 1024)) MB" >&2
    exec systemd-run --user --scope --quiet "${props[@]}" -- "$@"
  fi
  if sudo -n systemd-run --scope --quiet "${props[@]}" --uid="$(id -u)" --gid="$(id -g)" true >/dev/null 2>&1; then
    echo "scoped.sh: system scope, MemoryMax=$((max / 1024)) MB" >&2
    # sudo resets PATH (secure_path) and some of the environment: pass it on
    exec sudo -n --preserve-env systemd-run --scope --quiet "${props[@]}" --uid="$(id -u)" --gid="$(id -g)" -- env "PATH=$PATH" "HOME=$HOME" "$@"
  fi
fi
echo "scoped.sh: no systemd scope available; running without a whole-run memory cap" >&2
exec "$@"
