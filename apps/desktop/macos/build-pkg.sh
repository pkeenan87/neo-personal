#!/bin/bash
# Builds Neo-<version>.pkg: the signed (or, for CI, unsigned) installer for macOS.
#
#   apps/desktop/macos/build-pkg.sh --version 0.1.0 --out /path/to/output [--tray-app /path/Neo.app]
#
# Needs the tray app built first:  pnpm exec tauri build --target universal-apple-darwin --bundles app
# (default location: target/universal-apple-darwin/release/bundle/macos/Neo.app).
#
# The daemon is built here for both architectures and joined with lipo. Signing is optional:
#   APPLE_SIGNING_IDENTITY     "Developer ID Application: Name (TEAMID)"  signs the daemon bundle
#   APPLE_INSTALLER_IDENTITY   "Developer ID Installer: Name (TEAMID)"    signs the pkg
#   APPLE_KEYCHAIN             optional keychain holding the identities
# Without them everything is ad-hoc signed and the pkg is unsigned: fine for CI, refused by
# Gatekeeper on a real Mac (the release workflow fails if the identities are missing).
#
# NEO_CARGO_FLAGS overrides the cargo flags (default --locked; the CI "version N+1" build bumps the
# workspace version, which changes Cargo.lock, so it passes an empty value).
#
# Environment compiled into the daemon (NEO_BASE_URL, NEO_DESKTOP_UPDATE_URL,
# NEO_DESKTOP_UPDATE_PUBKEY, NEO_ALLOW_UNSIGNED_UPDATE, NEO_TRASH_GRACE_SECS) is read by cargo here.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(cd "$here/.." && pwd)"

version=""
out=""
tray_app="$desktop/target/universal-apple-darwin/release/bundle/macos/Neo.app"
daemon_bin=""
while [ $# -gt 0 ]; do
	case "$1" in
	--version) version="$2"; shift 2 ;;
	--out) out="$2"; shift 2 ;;
	--tray-app) tray_app="$2"; shift 2 ;;
	--daemon-bin) daemon_bin="$2"; shift 2 ;;
	*) echo "unknown option $1" >&2; exit 2 ;;
	esac
done
[ -n "$version" ] || { echo "--version is required" >&2; exit 2; }
[ -n "$out" ] || { echo "--out is required" >&2; exit 2; }
[ -d "$tray_app" ] || { echo "the tray app is not at $tray_app; build it first" >&2; exit 1; }

sign_id="${APPLE_SIGNING_IDENTITY:-}"
installer_id="${APPLE_INSTALLER_IDENTITY:-}"
keychain_args=()
if [ -n "${APPLE_KEYCHAIN:-}" ]; then keychain_args=(--keychain "$APPLE_KEYCHAIN"); fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"
out="$(cd "$out" && pwd)"

# ---- the daemon, universal ----------------------------------------------------------------------
if [ -z "$daemon_bin" ]; then
	(
		cd "$desktop"
		# shellcheck disable=SC2086 # the flags are meant to split
		cargo build --release ${NEO_CARGO_FLAGS---locked} -p neo-agent --target aarch64-apple-darwin
		# shellcheck disable=SC2086
		cargo build --release ${NEO_CARGO_FLAGS---locked} -p neo-agent --target x86_64-apple-darwin
	)
	daemon_bin="$work/neo-agent"
	lipo -create -output "$daemon_bin" \
		"$desktop/target/aarch64-apple-darwin/release/neo-agent" \
		"$desktop/target/x86_64-apple-darwin/release/neo-agent"
fi
lipo -info "$daemon_bin"

# ---- the payload --------------------------------------------------------------------------------
root="$work/root"
daemon_app="$root/Library/Application Support/Neo/Neo Protection.app"
mkdir -p "$root/Applications" "$root/Library/Application Support/Neo" "$root/Library/LaunchDaemons" "$root/Library/LaunchAgents"
cp -R "$here/Neo Protection.app" "$daemon_app"
mkdir -p "$daemon_app/Contents/MacOS"
cp "$daemon_bin" "$daemon_app/Contents/MacOS/neo-agent"
chmod 755 "$daemon_app/Contents/MacOS/neo-agent" "$daemon_app/Contents/Resources/uninstall.sh"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $version" "$daemon_app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" "$daemon_app/Contents/Info.plist"

cp -R "$tray_app" "$root/Applications/Neo.app"
cp "$here/launchd/dev.neoshield.agent.plist" "$root/Library/LaunchDaemons/"
cp "$here/launchd/dev.neoshield.tray.plist" "$root/Library/LaunchAgents/"
chmod 644 "$root/Library/LaunchDaemons/dev.neoshield.agent.plist" "$root/Library/LaunchAgents/dev.neoshield.tray.plist"

# ---- signing ------------------------------------------------------------------------------------
if [ -n "$sign_id" ]; then
	# Hardened runtime and a secure timestamp: both are required for notarization.
	codesign --force --options runtime --timestamp --sign "$sign_id" ${keychain_args[@]+"${keychain_args[@]}"} "$daemon_app"
	# The tray app was signed by Tauri (APPLE_SIGNING_IDENTITY at build time); check, don't redo.
	codesign --verify --deep --strict "$root/Applications/Neo.app"
else
	codesign --force --sign - "$daemon_app"
	codesign --force --deep --sign - "$root/Applications/Neo.app"
fi
codesign --verify --deep --strict "$daemon_app"
team_of() { codesign -dv --verbose=4 "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p'; }
daemon_team="$(team_of "$daemon_app")"
tray_team="$(team_of "$root/Applications/Neo.app")"
echo "Team IDs: daemon '${daemon_team}', tray app '${tray_team}'"
if [ "${daemon_team:-not set}" != "${tray_team:-not set}" ]; then
	echo "The daemon and the tray app are signed by different teams; the Trash rule and updates need the same one." >&2
	exit 1
fi
if [ -n "$sign_id" ] && { [ -z "$daemon_team" ] || [ "$daemon_team" = "not set" ]; }; then
	echo "Signed with an identity, but the daemon has no Team ID." >&2
	exit 1
fi

# ---- the package --------------------------------------------------------------------------------
# Bundles in a payload are "relocatable" by default: the installer would update a copy of the same
# bundle id found anywhere on the disk instead of installing to /Applications. Turn that off, and
# overwrite on upgrade even if the version check would skip it.
pkgbuild --analyze --root "$root" "$work/components.plist"
i=0
# One entry per top-level bundle (nested ChildBundles are not indexed here).
while /usr/libexec/PlistBuddy -c "Print :$i:RootRelativeBundlePath" "$work/components.plist" >/dev/null 2>&1; do
	/usr/libexec/PlistBuddy -c "Set :$i:BundleIsRelocatable false" "$work/components.plist"
	/usr/libexec/PlistBuddy -c "Set :$i:BundleIsVersionChecked false" "$work/components.plist"
	/usr/libexec/PlistBuddy -c "Set :$i:BundleOverwriteAction upgrade" "$work/components.plist"
	i=$((i + 1))
done
[ "$i" -ge 2 ] || { echo "expected at least two bundles in the payload, found $i" >&2; exit 1; }

scripts="$work/scripts"
mkdir -p "$scripts"
cp "$here/scripts/preinstall" "$here/scripts/postinstall" "$scripts/"
chmod 755 "$scripts/preinstall" "$scripts/postinstall"

pkgbuild \
	--root "$root" \
	--install-location / \
	--scripts "$scripts" \
	--component-plist "$work/components.plist" \
	--identifier dev.neoshield.pkg \
	--version "$version" \
	--ownership recommended \
	"$work/neo-component.pkg"

sed "s/__VERSION__/$version/" "$here/distribution.xml" >"$work/distribution.xml"
sign_args=()
if [ -n "$installer_id" ]; then
	sign_args=(--sign "$installer_id" --timestamp)
	if [ -n "${APPLE_KEYCHAIN:-}" ]; then sign_args+=(--keychain "$APPLE_KEYCHAIN"); fi
fi
productbuild \
	--distribution "$work/distribution.xml" \
	--package-path "$work" \
	${sign_args[@]+"${sign_args[@]}"} \
	"$out/Neo-$version.pkg"

echo "Built $out/Neo-$version.pkg"
pkgutil --check-signature "$out/Neo-$version.pkg" || true
