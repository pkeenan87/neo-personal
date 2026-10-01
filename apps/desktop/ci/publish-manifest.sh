#!/bin/bash
# Publishes this platform's entry into the shared update manifest (`latest.json` on the rolling
# `desktop-latest` release), merging with what the other platform's release workflow published.
#
#   publish-manifest.sh --platform darwin-universal --version 0.2.0 --url <asset url> \
#       --sig-file <file.sig> --notes "..." --dir <scratch dir>
#
# Needs `gh` (with GH_TOKEN) and node. The Windows and macOS release workflows can run at the same
# time, and a release asset cannot be updated atomically, so after uploading this re-downloads the
# manifest and, if this platform's entry is not in it (the other workflow uploaded in between),
# merges and uploads again. The last writer always starts from what the other one wrote.
# The merged manifest is left in <dir>/latest.json for the caller to attach to the tagged release.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
platform="" version="" url="" sig_file="" notes="" dir=""
while [ $# -gt 0 ]; do
	case "$1" in
	--platform) platform="$2"; shift 2 ;;
	--version) version="$2"; shift 2 ;;
	--url) url="$2"; shift 2 ;;
	--sig-file) sig_file="$2"; shift 2 ;;
	--notes) notes="$2"; shift 2 ;;
	--dir) dir="$2"; shift 2 ;;
	*) echo "unknown option $1" >&2; exit 2 ;;
	esac
done
for v in platform version url sig_file dir; do
	[ -n "${!v}" ] || { echo "--${v//_/-} is required" >&2; exit 2; }
done
mkdir -p "$dir"

# The agent reads a fixed address, so the manifest lives on a rolling pre-release (`releases/latest`
# would point at whichever release, extension or desktop, is newest).
gh release view desktop-latest >/dev/null 2>&1 || gh release create desktop-latest \
	--prerelease --title "Desktop update manifest" \
	--notes "Rolling release holding latest.json, which installed agents check daily. Do not delete." ||
	gh release view desktop-latest >/dev/null

has_our_entry() {
	node -e '
		const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
		const ours = require("fs").readFileSync(process.argv[3], "utf8").trim();
		const p = (m.platforms || {})[process.argv[2]];
		process.exit(m.version === process.argv[4] && p && p.signature === ours ? 0 : 1);
	' "$1" "$platform" "$sig_file" "$version"
}

for attempt in 1 2 3 4 5; do
	rm -rf "$dir/existing" "$dir/verify"
	mkdir -p "$dir/existing" "$dir/verify"
	gh release download desktop-latest --pattern latest.json --dir "$dir/existing" --clobber 2>/dev/null || true
	node "$here/make-latest-json.mjs" \
		--version "$version" --url "$url" --sig-file "$sig_file" --platform "$platform" \
		--notes "$notes" --merge-into "$dir/existing/latest.json" --out "$dir/latest.json"
	gh release upload desktop-latest "$dir/latest.json" --clobber
	sleep 5
	gh release download desktop-latest --pattern latest.json --dir "$dir/verify" --clobber
	if has_our_entry "$dir/verify/latest.json"; then
		echo "latest.json on desktop-latest has the $platform entry (attempt $attempt):"
		cat "$dir/verify/latest.json"
		cp "$dir/verify/latest.json" "$dir/latest.json"
		exit 0
	fi
	echo "The $platform entry is not in the published manifest (another release uploaded at the same time); merging again."
done
echo "Could not publish the $platform entry to latest.json after 5 attempts." >&2
exit 1
