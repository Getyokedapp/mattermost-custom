#!/usr/bin/env bash
# Install or upgrade the out-of-band Mattermost plugins listed in the manifest.
#
# Run on the Docker host, as root, next to the running server container. Each
# manifest line names the plugin id, the GitHub repo, the release-asset regex and
# whether prereleases count. The script compares the release tag with the version
# the server reports and only touches plugins whose version changed, so it is safe
# to run from a timer.
#
#   ./update-plugins.sh                 # apply updates
#   ./update-plugins.sh --dry-run       # report what would change
#   ./update-plugins.sh --manifest FILE # alternate manifest
#
# Environment:
#   CONTAINER          server container name           (default: mattermost)
#   MMCTL              mmctl path inside the container (default: /mattermost/bin/mmctl)
#   GITHUB_TOKEN       raises the 60 req/h anonymous GitHub API limit
#   STATE_DIR          temp download directory         (default: /var/tmp/mm-plugin-updates)
#   CURL               curl binary                     (default: curl)
set -euo pipefail

CONTAINER="${CONTAINER:-mattermost}"
MMCTL="${MMCTL:-/mattermost/bin/mmctl}"
STATE_DIR="${STATE_DIR:-/var/tmp/mm-plugin-updates}"
CURL="${CURL:-curl}"
MANIFEST="$(dirname "$0")/plugins.manifest"
DRY_RUN=0

while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run) DRY_RUN=1; shift ;;
	--manifest) MANIFEST="$2"; shift 2 ;;
	-h | --help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

[ -r "$MANIFEST" ] || { echo "manifest not readable: $MANIFEST" >&2; exit 1; }

# One updater at a time: a slow download must not race the next timer tick.
exec 9>/var/lock/mm-plugin-updates.lock
flock -n 9 || { log "another run holds the lock, exiting"; exit 0; }

mkdir -p "$STATE_DIR"

# `mmctl plugin list` prints "id: Name, Version: x.y.z" for installed plugins.
installed_version() {
	docker exec "$CONTAINER" "$MMCTL" --local plugin list 2>/dev/null |
		awk -F': ' -v id="$1" '$0 ~ "^"id":" {print $3; exit}'
}

api_get() {
	if [ -n "${GITHUB_TOKEN:-}" ]; then
		"$CURL" -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" "$@"
	else
		"$CURL" -fsSL "$@"
	fi
}

updated=0
failed=0

while IFS=$'\t' read -r id repo asset prerelease; do
	case "$id" in '' | '#'*) continue ;; esac
	[ -n "${asset:-}" ] || { log "SKIP ${id}: no asset regex"; continue; }

	release_url="https://api.github.com/repos/${repo}/releases/latest"
	if [ "${prerelease:-0}" = "1" ]; then
		release_url="https://api.github.com/repos/${repo}/releases?per_page=1"
	fi

	release="$(api_get "$release_url" 2>/dev/null)" || { log "FAIL ${id}: cannot query ${repo}"; failed=$((failed + 1)); continue; }
	[ "${prerelease:-0}" = "1" ] && release="$(printf '%s' "$release" | jq '.[0]')"

	tag="$(printf '%s' "$release" | jq -r '.tag_name // empty')"
	url="$(printf '%s' "$release" | jq -r --arg re "$asset" \
		'[.assets[] | select(.name | test($re)) | select(.name | test("\\.(asc|sig|intoto\\.jsonl|sigstore\\.json|json)$") | not)] | first | .browser_download_url // empty')"
	[ -n "$tag" ] && [ -n "$url" ] || { log "FAIL ${id}: no release asset matching /${asset}/ in ${tag:-<no tag>}"; failed=$((failed + 1)); continue; }

	want="${tag#v}"
	have="$(installed_version "$id")"
	case "$have" in
	"$want" | "$want"-*) log "OK   ${id} ${have}"; continue ;;
	"") log "NEW  ${id} ${want} (not installed)" ;;
	*) log "UPGRADE ${id} ${have} -> ${want}" ;;
	esac

	if [ "$DRY_RUN" = "1" ]; then
		updated=$((updated + 1))
		continue
	fi

	tarball="${STATE_DIR}/${id}-${want}.tar.gz"
	if ! "$CURL" -fsSL -o "$tarball" "$url"; then
		log "FAIL ${id}: download failed: ${url}"
		failed=$((failed + 1))
		continue
	fi

	inside="/tmp/$(basename "$tarball")"
	if ! docker cp "$tarball" "${CONTAINER}:${inside}" >/dev/null; then
		log "FAIL ${id}: docker cp failed"; failed=$((failed + 1)); rm -f "$tarball"; continue
	fi

	if out="$(docker exec "$CONTAINER" "$MMCTL" --local plugin add "$inside" 2>&1)"; then
		# Keep the plugin enabled if it was enabled before the upgrade.
		docker exec "$CONTAINER" "$MMCTL" --local plugin enable "$id" >/dev/null 2>&1 || true
		log "DONE ${id} -> ${want}"
		updated=$((updated + 1))
	else
		log "FAIL ${id}: $(printf '%s' "$out" | tail -1)"
		failed=$((failed + 1))
	fi
	docker exec "$CONTAINER" rm -f "$inside" >/dev/null 2>&1 || true
	rm -f "$tarball"
done <"$MANIFEST"

log "finished: ${updated} changed, ${failed} failed"
[ "$failed" -eq 0 ]
