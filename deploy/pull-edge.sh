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

IMAGE="${IMAGE:-ghcr.io/getyokedapp/mattermost-custom:edge}"
COMPOSE_DIR="${COMPOSE_DIR:-/srv/mattermost}"
SERVICE="${SERVICE:-mattermost}"
CONTAINER="${CONTAINER:-mattermost}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
DRY_RUN=0

[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

exec 9>/var/lock/mm-edge-deploy.lock
flock -n 9 || { log "another run holds the lock"; exit 0; }

cd "$COMPOSE_DIR"
[ -f .env ] || { log "no .env in ${COMPOSE_DIR}"; exit 1; }

prev_id="$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"

if ! docker pull -q "$IMAGE" >/dev/null 2>&1; then
	log "FAIL could not pull ${IMAGE} (not logged in to ghcr, or the tag is gone)"
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
	docker tag "$prev_id" mattermost:rollback >/dev/null 2>&1 || true
fi

if grep -q '^MM_IMAGE=' .env; then
	sed -i "s|^MM_IMAGE=.*|MM_IMAGE=${IMAGE}|" .env
else
	printf 'MM_IMAGE=%s\n' "$IMAGE" >>.env
fi

log "deploying ${IMAGE} (${new_id:0:19})"
docker compose up -d --no-deps "$SERVICE" >/dev/null 2>&1 || {
	log "FAIL compose up failed"
	[ -n "$prev_id" ] && { sed -i "s|^MM_IMAGE=.*|MM_IMAGE=mattermost:rollback|" .env; docker compose up -d --no-deps "$SERVICE" >/dev/null 2>&1; }
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
	sed -i "s|^MM_IMAGE=.*|MM_IMAGE=mattermost:rollback|" .env
	docker compose up -d --no-deps "$SERVICE" >/dev/null 2>&1 || true
fi
exit 1
