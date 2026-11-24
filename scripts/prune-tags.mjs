#!/usr/bin/env node
/**
 * Tag retention for the internal registry.
 *
 * Deletes the oldest tags matching a prefix, keeping the newest N. Then asks the
 * registry to garbage-collect the now-untagged blobs. Dry-run unless --apply.
 *
 * Only tags are ordered here; the registry API has no creation timestamp, so
 * ordering is natural-sort over the tag names. Use tags with a sortable
 * version/build component (for example mm-v12.1.0-abc1234).
 *
 * Usage:
 *   REGISTRY=registry.internal.getyokedapp.com REGISTRY_USERNAME=ci REGISTRY_PASSWORD=... \
 *   node scripts/prune-tags.mjs --repo getyokedapp/mattermost-custom \
 *     --prefix mm- --keep 6 --apply
 */

const args = (() => {
  const parsed = { keep: 0, apply: false, gc: true };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--registry": parsed.registry = argv[++i]; break;
      case "--repo": parsed.repo = argv[++i]; break;
      case "--prefix": parsed.prefix = argv[++i]; break;
      case "--keep": parsed.keep = Number(argv[++i]); break;
      case "--username": parsed.username = argv[++i]; break;
      case "--password": parsed.password = argv[++i]; break;
      case "--apply": parsed.apply = true; break;
      case "--no-gc": parsed.gc = false; break;
      case "-h":
      case "--help":
        console.log("usage: prune-tags.mjs --repo <name> --prefix <prefix> --keep <n> [--apply] [--no-gc]");
        process.exit(0);
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  return parsed;
})();

const registry = args.registry ?? process.env.REGISTRY;
const repo = args.repo;
const prefix = args.prefix ?? "";
const keep = args.keep;
const username = args.username ?? process.env.REGISTRY_USERNAME;
const password = args.password ?? process.env.REGISTRY_PASSWORD;

if (!registry || !repo) throw new Error("REGISTRY and --repo are required");
if (!Number.isInteger(keep) || keep < 1) throw new Error("--keep must be a positive integer");
if (!username || !password) throw new Error("REGISTRY_USERNAME and REGISTRY_PASSWORD are required");

const base = /^http:\/\//.test(registry)
  ? registry.replace(/\/+$/, "")
  : `https://${registry.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

const headers = { Authorization: auth };

async function listTags() {
  const tags = [];
  let url = `${base}/v2/${repo}/tags/list?n=100`;
  while (url) {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
    const body = await response.json();
    tags.push(...(body.tags ?? []));
    const link = response.headers.get("Link");
    const next = link?.match(/<([^>]+)>;\s*rel="?next"?/);
    url = next ? new URL(next[1], base).toString() : null;
  }
  return tags;
}

function naturalCompare(a, b) {
  const split = (value) => value.match(/\d+|\D+/g) ?? [];
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? "";
    const r = right[i] ?? "";
    if (l === r) continue;
    const ln = Number(l);
    const rn = Number(r);
    if (Number.isFinite(ln) && Number.isFinite(rn) && ln !== rn) return ln - rn;
    return l < r ? -1 : 1;
  }
  return 0;
}

const all = await listTags();
const candidates = all.filter((tag) => tag.startsWith(prefix)).sort(naturalCompare);
const doomed = candidates.slice(0, Math.max(0, candidates.length - keep));

console.log(`${repo}: ${all.length} tags, ${candidates.length} match ${JSON.stringify(prefix)}, keeping ${keep}`);
if (doomed.length === 0) {
  console.log("nothing to prune");
  process.exit(0);
}

for (const tag of doomed) {
  if (!args.apply) {
    console.log(`would delete ${tag}`);
    continue;
  }
  const response = await fetch(`${base}/v2/${repo}/manifests/${encodeURIComponent(tag)}`, {
    method: "DELETE",
    headers,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`DELETE ${tag} -> ${response.status}`);
  }
  console.log(`deleted ${tag}`);
}

if (args.apply && args.gc && doomed.length > 0) {
  const response = await fetch(`${base}/v2/${repo}/gc?mode=untagged`, { method: "POST", headers });
  if (!response.ok) throw new Error(`gc -> ${response.status} ${await response.text()}`);
  console.log(`gc: ${await response.text()}`);
}
