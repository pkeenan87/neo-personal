#!/bin/bash
# Helpers for the `desktop-macos` CI job (sourced by its steps). Not for local use: it uses sudo.

requests_log="$RUNNER_TEMP/neo-requests.log"
data_dir="/Library/Application Support/Neo/data"

fail() {
	echo "::error::$*"
	exit 1
}

# One request to the daemon's socket, as an ordinary user (the socket is open to every local user).
req() {
	node "$GITHUB_WORKSPACE/apps/desktop/ci/socket-request.mjs" "$@"
}

# The number of DELETE /api/devices/self the fake server has seen (the owner-is-told call).
count_deletes() {
	grep -c '^DELETE /api/devices/self$' "$requests_log" || true
}

# `launchctl print` of the daemon; fails when it is not loaded.
daemon_print() {
	sudo launchctl print system/dev.neoshield.agent 2>&1
}

# Whether the daemon is loaded and running. Captures the output first: `daemon_print | grep -q`
# under `set -o pipefail` fails when grep exits early and sudo gets SIGPIPE.
daemon_running() {
	local out
	out="$(daemon_print)" || return 1
	grep -Eq '^[[:space:]]*state = running' <<<"$out"
}

# The pid launchd reports for the daemon.
daemon_pid() {
	local out
	out="$(daemon_print)" || return 1
	sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' <<<"$out" | head -n 1
}

# The daemon's logs, read as root (the directory is 0700 root, so the glob must expand under sudo).
daemon_logs() {
	sudo sh -c 'cat "$1"/logs/*.log' sh "$data_dir" 2>/dev/null
}

# Polls until the daemon answers `status` (up to $1 seconds), printing the reply.
wait_for_status() {
	local deadline=$((SECONDS + ${1:-60})) reply
	while [ "$SECONDS" -lt "$deadline" ]; do
		if reply="$(req '{"op":"status"}' --timeout 10 2>/dev/null)"; then
			echo "$reply"
			return 0
		fi
		sleep 2
	done
	return 1
}

# Copies the daemon's logs (root-only) and the installer log tail into $RUNNER_TEMP/keep/<label>.
collect_logs() {
	local label="$1" dest="$RUNNER_TEMP/keep/$1"
	mkdir -p "$dest"
	if sudo test -d "$data_dir"; then
		sudo find "$data_dir" -maxdepth 2 -print >"$dest/data-listing.txt" 2>&1 || true
		sudo cp -R "$data_dir/logs" "$dest/logs" 2>/dev/null || true
		sudo chown -R "$(id -un)" "$dest" 2>/dev/null || true
	else
		echo "$data_dir does not exist" >"$dest/data-listing.txt"
	fi
	sudo tail -n 400 /var/log/install.log >"$dest/install.log.tail" 2>/dev/null || true
	sudo chown "$(id -un)" "$dest"/* 2>/dev/null || true
}
