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
| google-drive, zoom, google-meet | need Google/Zoom OAuth apps and admin consent |
| gif-favorites, avatar-gif, text-fx | novelty cosmetics; no work-chat value, widest surface for least gain |
| request-hub | **no licence file**, so there is no permission to run it |
| secrets, urlsearch, stakeholder-questions | no releases published, so nothing to install or auto-update; `secrets` also needs a Vault/OpenBao backend |
| campfire | full standup/task/leave suite: a product, not a plugin. Needs its own setup and has no track record yet |
| bot-webhook | routes bot DMs to an HTTP endpoint; our Hermes bridge already consumes bot messages over the websocket |
| hermes-plugin-mattermost-enhancer | a **Hermes** plugin, not a Mattermost one — configure it in Hermes, not on the server |
| read-receipts by Morraycage / ghaffaria | duplicate implementations of the same feature; the adriadam10 fork above is the one kept |
