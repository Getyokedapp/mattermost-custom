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

From the release tarball, upgraded with the server: `com.mattermost.calls`,
`mattermost-ai` (Agents), `github`, `playbooks` (needs a licence, left disabled).

## Deliberately not installed

| Plugin | Why not |
| --- | --- |
| jitsi | needs a Jitsi Meet deployment to point at; Calls already covers meetings |
| google-calendar, google-meet | need a Google Workspace OAuth client and admin consent |
| giphy | needs a GIPHY API key; without it the plugin has nothing to call |
| alertmanager | needs a Prometheus Alertmanager endpoint we do not run |
| autotranslate | needs a translation provider key (DeepL/Google/Azure/LibreTranslate) |
| oidc (server-camp) | redundant: OIDC is already in the server via `patches/oidc-sso.patch`, and a second login path is a second way to get locked out |
