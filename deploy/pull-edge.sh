#!/usr/bin/env bash
# Redeploy the Mattermost container when the published :edge image changes.
#
# The image is built by .github/workflows/custom-image.yml on every push that
# touches patches/, server/ or deploy/, so this timer is what turns "we changed the
# fork" into "the running server is that change". It pulls, compares image ids, and
# only recreates the container when they differ. A container that does not reach
# healthy is rolled back to the image that was running before.
#
#   ./pull-edge.sh --dry-run
set -euo pipefail

# IMAGE defaults to the GitHub Container Registry build. Point it at another
# registry (e.g. an internal one) with IMAGE=... or by setting it in the unit.
IMAGE="${IMAGE:-ghcr.io/getyokedapp/mattermost-custom:edge}"
# REGISTRY_HOST is only set when the reference names one: Docker Hub refs like
# busybox:1.36 have no slash, and their tag can contain dots.
REGISTRY_HOST=""
case "$IMAGE" in
*/*)
	first="${IMAGE%%/*}"
	case "$first" in
	*.* | localhost) REGISTRY_HOST="$first" ;;
	esac
	;;
esac
COMPOSE_DIR="${COMPOSE_DIR:-/srv/mattermost}"
SERVICE="${SERVICE:-mattermost}"
CONTAINER="${CONTAINER:-mattermost}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
ROLLBACK_TAG="${ROLLBACK_TAG:-mattermost:rollback}"
DRY_RUN=0

[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

exec 9>/var/lock/mm-edge-deploy.lock
flock -n 9 || { log "another run holds the lock"; exit 0; }

cd "$COMPOSE_DIR"
[ -f .env ] || { log "no .env in ${COMPOSE_DIR}"; exit 1; }

prev_id="$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"

# The package is private. Prefer a pull-only credential injected into the unit
# environment (REGISTRY_USERNAME/REGISTRY_PASSWORD); fall back to a token file
# written by an operator (REGISTRY_TOKEN_FILE, or the ghcr path below). Without
# either, the pull is unauthorized and the run exits quietly.
TOKEN_FILE="${REGISTRY_TOKEN_FILE:-}"
if [ -z "$TOKEN_FILE" ]; then
	for candidate in /etc/mm-registry-token /etc/mm-ghcr-token; do
		[ -f "$candidate" ] && { TOKEN_FILE="$candidate"; break; }
	done
fi

if [ -n "$REGISTRY_HOST" ] && [ -n "${REGISTRY_PASSWORD:-}" ]; then
	printf '%s' "$REGISTRY_PASSWORD" |
		docker login "$REGISTRY_HOST" -u "${REGISTRY_USERNAME:?REGISTRY_USERNAME is required with REGISTRY_PASSWORD}" \
			--password-stdin >/dev/null 2>&1 || log "warning: registry login failed"
elif [ -n "$REGISTRY_HOST" ] && [ -n "$TOKEN_FILE" ] && [ -f "$TOKEN_FILE" ]; then
	docker login "$REGISTRY_HOST" -u "${REGISTRY_USER:-getyokedapp}" \
		--password-stdin <"$TOKEN_FILE" >/dev/null 2>&1 ||
		log "warning: registry login failed"
fi

if ! pull_out="$(docker pull -q "$IMAGE" 2>&1)"; then
	case "$pull_out" in
	*unauthorized* | *"denied"* | *"authentication required"*)
		# Keep the timer quiet: a bad or missing credential should be visible in the
		# log, not produce a failed unit every ten minutes.
		log "SKIP ${IMAGE} is not pullable (set REGISTRY_USERNAME/REGISTRY_PASSWORD or write a token to /etc/mm-registry-token)"
		exit 0
		;;
	esac
	log "FAIL pull failed: $(printf '%s' "$pull_out" | tail -1)"
	exit 1
fi
new_id="$(docker image inspect --format '{{.Id}}' "$IMAGE")"

if [ -n "$prev_id" ] && [ "$prev_id" = "$new_id" ]; then
	log "up to date ($(printf '%s' "$new_id" | cut -c8-19))"
	exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
	log "would deploy ${IMAGE} (${new_id:0:19})"
	exit 0
fi

# Remember what was running so a bad image can be undone without a rebuild.
if [ -n "$prev_id" ]; then
	docker tag "$prev_id" "$ROLLBACK_TAG" >/dev/null 2>&1 || true
fi

if grep -q '^MM_IMAGE=' .env; then
	sed -i "s|^MM_IMAGE=.*|MM_IMAGE=${IMAGE}|" .env
else
	printf 'MM_IMAGE=%s\n' "$IMAGE" >>.env
fi

log "deploying ${IMAGE} (${new_id:0:19})"
docker compose up -d --no-deps "$SERVICE" >/dev/null 2>&1 || {
	log "FAIL compose up failed"
	[ -n "$prev_id" ] && { sed -i "s|^MM_IMAGE=.*|MM_IMAGE=${ROLLBACK_TAG}|" .env; docker compose up -d --no-deps "$SERVICE" >/dev/null 2>&1; }
	exit 1
}

deadline=$((SECONDS + HEALTH_TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ]; do
	status="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)"
	if [ "$status" = "healthy" ]; then
		log "healthy on ${new_id:0:19}"
		exit 0
	fi
	sleep 5
done

log "FAIL ${CONTAINER} not healthy after ${HEALTH_TIMEOUT}s (status=${status:-unknown}), rolling back"
if [ -n "$prev_id" ]; then
	sed -i "s|^MM_IMAGE=.*|MM_IMAGE=${ROLLBACK_TAG}|" .env
	docker compose up -d --no-deps "$SERVICE" >/dev/null 2>&1 || true
fi
exit 1
