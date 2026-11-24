# Deployment

Three pieces move independently, so each one has its own trigger:

| Piece | Built by | Installed by |
| --- | --- | --- |
| server binary + image | `upstream-sync.yml` on a new upstream tag, `custom-image.yml` on a push that touches `patches/`, `server/` or `deploy/` | `pull-edge.sh` on a 10 minute timer |
| plugins | their own GitHub releases | `update-plugins.sh` on a daily timer |
| config | `.env` and `compose` on the host | `docker compose up -d` |

## Server image

`custom-image.yml` publishes `registry.internal.getyokedapp.com/getyokedapp/mattermost-custom` —
`:edge` plus `:mm-<tag>-<sha>` — from the newest final upstream tag plus `patches/` as
they are on master, keeping the six newest `mm-` tags. The existing
`ghcr.io/getyokedapp/mattermost-custom` package is no longer written to; it stays as
the fallback the host currently pulls from. `pull-edge.sh` pulls `IMAGE`, compares image ids, and only recreates the
container when the image changed; if the new container does not report healthy within
`HEALTH_TIMEOUT` (180s) it is rolled back to the image that was running before, tagged
`mattermost:rollback`.

```sh
./pull-edge.sh --dry-run
journalctl -u mattermost-edge.service -n 40
```

`IMAGE` defaults to the ghcr `:edge` tag. Point the timer at a different registry
without editing the script:

```sh
# /etc/systemd/system/mattermost-edge.service.d/registry.conf
[Service]
Environment=IMAGE=registry.internal.getyokedapp.com/getyokedapp/mattermost-custom:edge
Environment=REGISTRY_USERNAME=getyokedapp
EnvironmentFile=/etc/mm-registry.env   # REGISTRY_PASSWORD=...
```

The internal registry's Terraform (bucket, deploy token, Phase credentials) lives in
`terraform-infra/infrastructure/cloudflare_internal_registry.tf`, and the Worker
itself deploys from `internal-registry/.github/workflows/deploy.yml`. Until the first
registry-published `:edge` has been pulled successfully on the host, leave `IMAGE` at
the ghcr default. After that, install the drop-in above with the read-only pair:

```ini
Environment=REGISTRY_USERNAME=registry-ro
Environment=REGISTRY_PASSWORD=<REGISTRY_READONLY_PASSWORD from Phase>
```

Then set `IMAGE=registry.internal.getyokedapp.com/getyokedapp/mattermost-custom:edge` in the
same drop-in so a registry outage is a one-line revert.

## Host configuration

`deploy/docker-compose.yml` and `deploy/.env.example` are the source of truth for
`/srv/mattermost`. To rebuild the host from scratch: create `/srv/mattermost`, copy the
compose file there, write `.env` from the example (mode 600, only the database URL
needs filling in), then `docker compose up -d`. Install the four units with
`copy deploy/*.service deploy/*.timer /etc/systemd/system/` and enable both timers.

The package is private, so `pull-edge.sh` logs in before pulling. It uses
`REGISTRY_USERNAME`/`REGISTRY_PASSWORD` when the unit provides them, otherwise a token
file — `/etc/mm-registry-token`, or `/etc/mm-ghcr-token` (mode 600, currently present,
`GHCR_USER` in the unit names the token owner). Login is skipped entirely when `IMAGE`
has no registry host. Making the package public removes the need for the file.

The compose file reads `MM_IMAGE`, so a manual deploy of a specific build is:

```sh
sed -i 's|^MM_IMAGE=.*|MM_IMAGE=ghcr.io/getyokedapp/mattermost-custom:mm-v12.1.0-abc1234|' /srv/mattermost/.env
docker compose -f /srv/mattermost/docker-compose.yml up -d
```

# Plugin deployment

The server image carries only the plugins published with the Mattermost release
tarball (Calls, Playbooks, Agents, GitHub). Everything else is an out-of-band
plugin: it is installed from its own GitHub release and upgraded independently of
the server, because those projects cut releases on their own schedule and pinning
them to our image would mean rebuilding Mattermost to take a plugin fix.

`plugins.manifest` is the list of out-of-band plugins. `update-plugins.sh` reads it,
compares each GitHub release tag with the version `mmctl plugin list` reports, and
installs the ones that changed.

```sh
./update-plugins.sh --dry-run   # what would change
./update-plugins.sh             # apply
```

`mattermost-plugins.{service,timer}` run it daily at 04:17 UTC with
`Persistent=true`, so a missed run happens on next boot. Logs:

```sh
journalctl -u mattermost-plugins.service -n 50
```

Set `GITHUB_TOKEN` in the service environment (`Environment=GITHUB_TOKEN=...`) if
the unauthenticated 60 requests/hour limit becomes a problem; five plugins a day
does not need it.

## Why a plugin rather than a patch

A server patch has to be repaired against every upstream release and rebuilt as a
binary; a plugin is versioned independently and can be replaced at runtime. Only
behaviour the plugin API cannot express belongs in `patches/`:

| Want | Mechanism | Reason |
| --- | --- | --- |
| no seat cap, no post-history cap | `patches/limits-no-cap.patch` | limits are computed in server internals |
| generic OIDC login | `patches/oidc-sso.patch` | an SSO provider must be registered inside the server |
| hide free-tier upgrade nag | `freemium` plugin | pure webapp UI; the plugin API can do it |
| linkify ticket ids, todos, profile attributes, boards | plugins | ordinary plugin surface |
| branding, custom emoji, themes | config, not code | System Console already covers it |

## Currently installed

Managed by the manifest:

| Plugin | Repo | Notes |
| --- | --- | --- |
| `freemium` | dy0gu/mattermost-plugin-freemium | hides free-edition labels and upgrade prompts |
| `mattermost-autolink` | mattermost-community/mattermost-plugin-autolink | regex links (tickets, PRs) in posts |
| `com.mattermost.plugin-todo` | mattermost-community/mattermost-plugin-todo | turn a post into a trackable todo |
| `com.mattermost.custom-attributes` | mattermost-community/mattermost-plugin-custom-attributes | per-user custom profile fields |
| `focalboard` | mattermost/mattermost-plugin-boards | boards/cards, no licence needed on this build |
| `com.github.adriadam10.mermaid` | adriadam10/mattermost-plugin-mermaid | renders ```mermaid blocks; **webapp-only**, no server binary |
| `render-md` | jaschadub/mattermost-render-md-plugin | `.md` attachments open rendered; **webapp-only** |
| `com.github.adriadam10.read-receipts` | adriadam10/mattermost-plugin-read-receipts | WhatsApp-style ticks + message info; server part |
| `forward-anywhere` | SadeqRouhani/mattermost-forward-anywhere | forward a post to any channel/DM, replacing built-in Forward |
| `com.mattermost.google-meet` | mattermost/mattermost-plugin-google-meet | Meet links in channels; needs a Google OAuth app |
| `com.mattermost-community.plugin-google-drive` | mattermost/mattermost-plugin-google-drive | Drive file search/share; needs a Google OAuth app |
| `com.mattermost.gcal` | mattermost/mattermost-plugin-google-calendar | **installed but disabled** (`enabled=0` in the manifest): it refuses to activate without OAuth2 credentials and retries loudly, so it stays off until they are set |

From the release tarball, upgraded with the server: `com.mattermost.calls`,
`mattermost-ai` (Agents), `github`, `playbooks` (needs a licence, left disabled).

## Deliberately not installed

| Plugin | Why not |
| --- | --- |
| jitsi | needs a Jitsi Meet deployment to point at; Calls already covers meetings |
| giphy | needs a GIPHY API key; without it the plugin has nothing to call |
| alertmanager | needs a Prometheus Alertmanager endpoint we do not run |
| autotranslate | needs a translation provider key (DeepL/Google/Azure/LibreTranslate) |
| oidc (server-camp) | redundant: OIDC is already in the server via `patches/oidc-sso.patch`, and a second login path is a second way to get locked out |
| zoom | needs a Zoom OAuth app; no Zoom account in use |
| gif-favorites, avatar-gif, text-fx | novelty cosmetics; no work-chat value, widest surface for least gain |
| request-hub | **no licence file**, so there is no permission to run it |
| secrets, urlsearch, stakeholder-questions | no releases published, so nothing to install or auto-update; `secrets` also needs a Vault/OpenBao backend |
| campfire | full standup/task/leave suite: a product, not a plugin. Needs its own setup and has no track record yet |
| bot-webhook | routes bot DMs to an HTTP endpoint; our Hermes bridge already consumes bot messages over the websocket |
| hermes-plugin-mattermost-enhancer | a **Hermes** plugin, not a Mattermost one — configure it in Hermes, not on the server |
| read-receipts by Morraycage / ghaffaria | duplicate implementations of the same feature; the adriadam10 fork above is the one kept |
