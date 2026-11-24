#!/usr/bin/env node
/**
 * Push an OCI image layout to the internal registry.
 *
 * Why this exists: Docker's own `docker push` sends each layer as one request.
 * Cloudflare caps request bodies at 100 MB on Free/Pro zones, so any layer over
 * that limit gets a 413. This script uses the registry's chunked-upload API
 * (POST /blobs/uploads, PATCH in <=64 MiB pieces, PUT with the digest), which
 * keeps every request under the cap regardless of layer size.
 *
 * Input is either an OCI layout directory/tar, or a `docker save` archive:
 *   docker save -o image.tar repo:tag
 *   docker buildx build --output type=oci,dest=image.tar -t repo:tag .
 * `docker save` is the default for CI because the docker buildx driver cannot
 * use the OCI exporter without a separate containerd-backed builder.
 *
 * Usage:
 *   REGISTRY=registry.getyokedapp.com \
 *   REGISTRY_USERNAME=ci REGISTRY_PASSWORD=... \
 *   node scripts/push-oci.mjs --repo getyokedapp/mattermost-custom \
 *     --tag edge --tag mm-v12.1.0-abc1234 --docker-save image.tar
 *
 * Blobs already present in the registry are skipped, so re-pushing only uploads
 * what changed.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createGzip } from "node:zlib";
import { once } from "node:events";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 64 MiB: comfortably under the 100 MB Worker request-body cap and above the
// 5 MiB minimum part size the registry enforces for multipart uploads.
const CHUNK_SIZE = 64 * 1024 * 1024;

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    [
      "usage: push-oci.mjs --repo <name> --tag <tag> [--tag <tag>...]",
      "                       (--layout <dir> | --archive <file.tar>) [--registry <host>]",
      "",
      "env: REGISTRY (host), REGISTRY_USERNAME, REGISTRY_PASSWORD",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { tags: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--registry":
        args.registry = value;
        i++;
        break;
      case "--repo":
        args.repo = value;
        i++;
        break;
      case "--tag":
        args.tags.push(value);
        i++;
        break;
      case "--layout":
        args.layout = value;
        i++;
        break;
      case "--archive":
        args.archive = value;
        i++;
        break;
      case "--docker-save":
        args.dockerSave = value;
        i++;
        break;
      case "--username":
        args.username = value;
        i++;
        break;
      case "--password":
        args.password = value;
        i++;
        break;
      case "-h":
      case "--help":
        usage();
        break;
      default:
        usage(`unknown argument ${flag}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const registry = args.registry ?? process.env.REGISTRY;
const repo = args.repo;
const tags = args.tags;
const username = args.username ?? process.env.REGISTRY_USERNAME;
const password = args.password ?? process.env.REGISTRY_PASSWORD;

if (!registry) usage("no registry (--registry or REGISTRY)");
if (!repo) usage("no repository (--repo)");
if (tags.length === 0) usage("at least one --tag is required");
const inputs = [args.layout, args.archive, args.dockerSave].filter(Boolean);
if (inputs.length !== 1) usage("pass exactly one of --layout, --archive or --docker-save");
if (!username || !password) usage("REGISTRY_USERNAME and REGISTRY_PASSWORD are required");

// Plain http is only for a local `wrangler dev` registry; production is https.
const base = /^http:\/\//.test(registry)
  ? registry.replace(/\/+$/, "")
  : `https://${registry.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

let layoutDir = args.layout;
let cleanupDir = null;

async function extractArchive(archive) {
  const directory = await mkdtemp(join(tmpdir(), "oci-"));
  cleanupDir = directory;
  await execFileAsync("tar", ["-xf", archive, "-C", directory]);
  return directory;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { digest: `sha256:${hash.digest("hex")}`, size };
}

async function gzipToFile(source, destination) {
  const hash = createHash("sha256");
  let size = 0;
  const output = createWriteStream(destination);
  const gzip = createGzip({ level: 6 });
  createReadStream(source).pipe(gzip);
  for await (const chunk of gzip) {
    hash.update(chunk);
    size += chunk.length;
    if (!output.write(chunk)) await once(output, "drain");
  }
  await new Promise((resolve, reject) => output.end((error) => (error ? reject(error) : resolve())));
  return { digest: `sha256:${hash.digest("hex")}`, size };
}

/**
 * Convert a `docker save` archive into an OCI layout, then return its path.
 * Layers in a docker-save archive are uncompressed tarballs, so each one is
 * gzipped deterministically (gzip -n semantics: no timestamp) before hashing.
 */
async function layoutFromDockerSave(archive) {
  const directory = await mkdtemp(join(tmpdir(), "docker-save-"));
  cleanupDir = directory;
  await execFileAsync("tar", ["-xf", archive, "-C", directory]);

  const entries = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("docker save archive has no manifest.json entries");
  }
  const entry = entries[0];
  const blobsDir = join(directory, "blobs", "sha256");
  await mkdir(blobsDir, { recursive: true });

  const configBytes = await readFile(join(directory, entry.Config));
  const config = JSON.parse(configBytes.toString("utf8"));
  const configDigest = `sha256:${createHash("sha256").update(configBytes).digest("hex")}`;
  await writeFile(join(blobsDir, configDigest.slice(7)), configBytes);

  const layers = [];
  for (const [index, layerPath] of entry.Layers.entries()) {
    const source = join(directory, layerPath);
    const compressed = join(directory, `layer-${index}.tar.gz`);
    const { digest, size } = await gzipToFile(source, compressed);
    await rename(compressed, join(blobsDir, digest.slice(7)));
    layers.push({
      mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip",
      digest,
      size,
    });
  }

  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: {
        mediaType: "application/vnd.docker.container.image.v1+json",
        digest: configDigest,
        size: configBytes.length,
      },
      layers,
    }),
  );
  const manifestDigest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  await writeFile(join(blobsDir, manifestDigest.slice(7)), manifest);
  await writeFile(
    join(directory, "index.json"),
    Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [
          {
            mediaType: "application/vnd.docker.distribution.manifest.v2+json",
            digest: manifestDigest,
            size: manifest.length,
            platform: { architecture: config.architecture ?? "amd64", os: config.os ?? "linux" },
          },
        ],
      }),
    ),
  );
  return directory;
}


async function request(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: auth, ...(init.headers ?? {}) },
  });
  if (response.status === 401) {
    throw new Error(
      `${init.method ?? "GET"} ${url} -> 401. Check REGISTRY_USERNAME/REGISTRY_PASSWORD. ` +
        "A missing credential on the Worker produces the same response.",
    );
  }
  return response;
}

async function expect(response, expected, context) {
  if (response.status !== expected) {
    const body = await response.text().catch(() => "");
    throw new Error(`${context} -> ${response.status} ${response.statusText} ${body.slice(0, 400)}`);
  }
}

function parseDigest(digest) {
  const index = digest.indexOf(":");
  if (index < 1) throw new Error(`invalid digest ${digest}`);
  return { algorithm: digest.slice(0, index), hex: digest.slice(index + 1) };
}

function blobPath(digest) {
  const { algorithm, hex } = parseDigest(digest);
  return join(layoutDir, "blobs", algorithm, hex);
}

async function readBlob(digest) {
  return readFile(blobPath(digest));
}

async function blobExists(digest) {
  const response = await request(`${base}/v2/${repo}/blobs/${digest}`, { method: "HEAD" });
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  throw new Error(`HEAD blob ${digest} -> ${response.status}`);
}

async function uploadBlob(digest, path, size) {
  // Docker's registry protocol: open a session, append chunks, then commit.
  const start = await request(`${base}/v2/${repo}/blobs/uploads/`, { method: "POST" });
  await expect(start, 202, `start upload ${digest}`);

  let location = new URL(start.headers.get("Location"), base).toString();
  const advertisedChunkMax = Number(start.headers.get("OCI-Chunk-Max-Length") ?? 0);
  const chunkSize =
    advertisedChunkMax > 0 ? Math.min(CHUNK_SIZE, advertisedChunkMax) : CHUNK_SIZE;

  // Read one chunk at a time so a multi-GB layer never sits in memory.
  const handle = await open(path, "r");
  try {
    for (let offset = 0; offset < size; offset += chunkSize) {
      const length = Math.min(chunkSize, size - offset);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (bytesRead !== length) {
        throw new Error(`short read for ${digest} at ${offset}: ${bytesRead}/${length}`);
      }
      const end = offset + length;
      const response = await request(location, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(length),
          "Content-Range": `${offset}-${end - 1}`,
        },
        body: chunk,
      });
      await expect(response, 202, `upload chunk ${digest} ${offset}-${end - 1}`);
      const next = response.headers.get("Location");
      if (!next) throw new Error(`chunk upload for ${digest} returned no Location`);
      location = new URL(next, base).toString();
    }
  } finally {
    await handle.close();
  }

  const commit = new URL(location);
  commit.searchParams.set("digest", digest);
  const finished = await request(commit.toString(), {
    method: "PUT",
    headers: { "Content-Length": "0" },
  });
  await expect(finished, 201, `commit blob ${digest}`);
}

async function ensureBlob(descriptor) {
  if (await blobExists(descriptor.digest)) {
    console.log(`  blob exists  ${descriptor.digest}`);
    return;
  }
  const path = blobPath(descriptor.digest);
  const info = await stat(path);
  // Catch a corrupt or mismatched layout before spending upload time.
  if (descriptor.digest.startsWith("sha256:")) {
    const { digest } = await sha256File(path);
    if (digest !== descriptor.digest) {
      throw new Error(`blob ${descriptor.digest} hashes to ${digest}`);
    }
  }
  console.log(`  blob upload  ${descriptor.digest} (${(info.size / 1048576).toFixed(1)} MiB)`);
  await uploadBlob(descriptor.digest, path, info.size);
}

function mediaTypeOf(manifest) {
  if (manifest.mediaType) return manifest.mediaType;
  return "manifests" in manifest
    ? "application/vnd.oci.image.index.v1+json"
    : "application/vnd.oci.image.manifest.v1+json";
}

async function putManifest(reference, bytes, contentType) {
  const response = await request(`${base}/v2/${repo}/manifests/${reference}`, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(bytes.length) },
    body: bytes,
  });
  await expect(response, 201, `put manifest ${reference}`);
  console.log(`  manifest     ${reference}`);
}

async function pushManifest(digest, tagsForManifest) {
  const bytes = await readBlob(digest);
  const manifest = JSON.parse(bytes.toString("utf8"));
  const contentType = mediaTypeOf(manifest);

  if (Array.isArray(manifest.manifests)) {
    // An index points at manifests, not blobs. Each child is pushed by digest
    // first because the registry verifies that on insert.
    for (const child of manifest.manifests) {
      await pushManifest(child.digest, []);
    }
  } else {
    await ensureBlob(manifest.config);
    for (const layer of manifest.layers ?? []) {
      await ensureBlob(layer);
    }
  }

  await putManifest(digest, bytes, contentType);
  for (const tag of tagsForManifest) {
    await putManifest(tag, bytes, contentType);
  }
}

async function main() {
  if (args.archive) {
    const info = await stat(args.archive);
    if (!info.isFile()) usage(`${args.archive} is not a file`);
    layoutDir = await extractArchive(args.archive);
  } else if (args.dockerSave) {
    const info = await stat(args.dockerSave);
    if (!info.isFile()) usage(`${args.dockerSave} is not a file`);
    layoutDir = await layoutFromDockerSave(args.dockerSave);
  }

  const rawIndex = await readFile(join(layoutDir, "index.json"), "utf8");
  const index = JSON.parse(rawIndex);
  if (!Array.isArray(index.manifests) || index.manifests.length === 0) {
    throw new Error("OCI layout index.json has no manifests");
  }

  // BuildKit can append provenance/attestation manifests to the layout index.
  // Pushing those as the tag would produce an image Docker cannot run, and
  // pushing only the first platform would silently drop the others.
  const isAttestation = (descriptor) =>
    descriptor.annotations?.["vnd.docker.reference.type"] === "attestation-manifest";
  const images = index.manifests.filter((descriptor) => !isAttestation(descriptor));
  if (images.length === 0) throw new Error("OCI layout index.json has no image manifest");

  console.log(`Tags: ${tags.join(", ")}`);

  if (images.length === 1) {
    console.log(`Pushing ${images[0].digest} to ${base}/${repo}`);
    await pushManifest(images[0].digest, tags);
  } else {
    // Multi-platform: push every child manifest, then publish an index that
    // references only the images (no attestation manifests we did not upload).
    for (const image of images) {
      console.log(`Pushing ${image.digest} (${image.platform?.os ?? "?"}/${image.platform?.architecture ?? "?"})`);
      await pushManifest(image.digest, []);
    }
    const multiArchIndex = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: index.mediaType ?? "application/vnd.oci.image.index.v1+json",
        manifests: images,
      }),
    );
    const digest = `sha256:${createHash("sha256").update(multiArchIndex).digest("hex")}`;
    const contentType = index.mediaType ?? "application/vnd.oci.image.index.v1+json";
    await putManifest(digest, multiArchIndex, contentType);
    for (const tag of tags) await putManifest(tag, multiArchIndex, contentType);
  }
  console.log("Done.");
}

try {
  await main();
} catch (error) {
  console.error(`push failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
}
