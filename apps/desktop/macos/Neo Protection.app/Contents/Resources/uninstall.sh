#!/bin/sh
# Removes Neo from this Mac: tells the server (so the household owner is told), stops and removes
# the daemon and the tray app, deletes the data, and forgets the package.
#
#   sudo "/Library/Application Support/Neo/Neo Protection.app/Contents/Resources/uninstall.sh"
#
# Also run by the tray's "Uninstall Neo..." (with administrator rights) and by the daemon itself when
# Neo.app has been moved to the Trash. Every step carries on if the one before failed, so a removal
# never stops half way.

# The tray's own launchd job is booted out last, which can end the process this script was started
# from; ignore the signals so the rest still runs.
trap '' HUP TERM

# The whole script is one function so the shell has read all of it before the files it lives in
# are deleted.
main() {
	if [ "$(/usr/bin/id -u)" -ne 0 ]; then
		echo "Run this with sudo." >&2
		return 1
	fi

	BASE="/Library/Application Support/Neo"
	AGENT="$BASE/Neo Protection.app/Contents/MacOS/neo-agent"

	# 1. Tell the server (DELETE /api/devices/self) and forget the token. When the daemon already
	#    did this (the Trash rule), there is nothing left to send.
	if [ -x "$AGENT" ]; then
		"$AGENT" --unenroll >/dev/null 2>&1 || true
	fi

	# 2. Stop the daemon and take it out of launchd, so it cannot be relaunched. `bootout` returns
	#    before the daemon has exited, and the daemon saves its state on the way out, so wait for
	#    the process to be gone before deleting its data (or it recreates the data folder).
	/bin/launchctl bootout system/dev.neoshield.agent >/dev/null 2>&1 || true
	/bin/rm -f /Library/LaunchDaemons/dev.neoshield.agent.plist
	/bin/rm -f /Library/LaunchAgents/dev.neoshield.tray.plist
	i=0
	while /usr/bin/pgrep -f "^$AGENT" >/dev/null 2>&1 && [ "$i" -lt 20 ]; do
		/bin/sleep 0.5
		i=$((i + 1))
	done
	/usr/bin/pkill -9 -f "^$AGENT" >/dev/null 2>&1 || true

	# 3. Remove the bundles, the data and the socket.
	/bin/rm -rf "$BASE"
	/bin/rm -rf /Applications/Neo.app
	/bin/rm -f /var/run/neo-agent.sock

	# 4. Forget the package.
	/usr/sbin/pkgutil --forget dev.neoshield.pkg >/dev/null 2>&1 || true

	# 5. Last: the tray app. Boot out its job for whoever is at the console (so launchd does not
	#    restart it), then stop any copy still running. This may end the process that started us.
	CONSOLE_UID=$(/usr/bin/stat -f %u /dev/console 2>/dev/null)
	if [ -n "$CONSOLE_UID" ] && [ "$CONSOLE_UID" -ne 0 ] 2>/dev/null; then
		/bin/launchctl bootout "gui/$CONSOLE_UID/dev.neoshield.tray" >/dev/null 2>&1 || true
	fi
	/usr/bin/pkill -f "^/Applications/Neo.app/Contents/MacOS/neo( |$)" >/dev/null 2>&1 || true
	return 0
}

main "$@"
exit $?
