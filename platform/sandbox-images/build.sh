#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
target=${1:?Usage: build.sh workplace|office VERSION}
version=${2:?Usage: build.sh workplace|office VERSION}
case "$target" in
  workplace) name=workplace; limit=2000000000 ;;
  office) name=workplace-office; limit=2600000000 ;;
  *) echo 'Unknown build target' >&2; exit 2 ;;
esac
[[ "$version" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] || { echo 'Invalid version' >&2; exit 2; }
for key in APT_MIRROR PIP_MIRROR NPM_MIRROR; do
  if ! node - "$key" "${!key:-}" <<'JS'
const [key, value] = process.argv.slice(2);
if (value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname ||
        url.username || url.password || /[\s%@?#"'\\]/.test(value)) throw Error();
  } catch { process.exitCode = 2; }
}
JS
  then
    echo "Invalid $key: use an HTTP address without credentials or query" >&2
    exit 2
  fi
done
cache=$(realpath -m "$HOME/.cache/ai-backoffice-v3/environments")
out=$(realpath -m "${SANDBOX_IMAGE_DIR:-$cache/sandbox-images}")
case "$out/" in "$cache/"*) ;; *) echo 'SANDBOX_IMAGE_DIR must be inside the environment cache' >&2; exit 2;; esac
dest="$out/$name-$version"
if [[ -e "$dest" || -e "$dest.manifest.json" || -e "$dest.digest" ]]; then
  echo 'Image version already exists. Choose a new version.' >&2; exit 2
fi
docker info >/dev/null
mkdir -p "$out"
exec 9>"$cache/build.lock"
flock 9
# Recheck after acquiring the shared build lock.
[[ ! -e "$dest" && ! -e "$dest.manifest.json" && ! -e "$dest.digest" ]] || { echo 'Image version already exists' >&2; exit 2; }
while ! sensors -j | node -e '
let text=""; process.stdin.on("data", b => text += b); process.stdin.on("end", () => {
  const temps=[];
  function visit(o) { for (const [k,v] of Object.entries(o)) {
    if (v && typeof v === "object") visit(v);
    else if (/^temp.*_input$/.test(k) && Number.isFinite(v)) temps.push(v);
  }}
  visit(JSON.parse(text));
  const mem = Number(require("fs").readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)/m)[1])*1024;
  console.error(JSON.stringify({max_temperature_c:Math.max(...temps),available_bytes:mem}));
  process.exit(temps.length && Math.max(...temps)<=92 && mem>=3*1024**3 ? 0 : 1);
});'; do
  echo 'Waiting for temperature <= 92 C and available memory >= 3 GiB' >&2
  sleep 15
done
builder=${SANDBOX_BUILDER:-oma-images}
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container >/dev/null
fi
tag="oma/$name:$version"
args=(--builder "$builder" --platform linux/amd64 --target "$target" --provenance=false --sbom=false)
for key in APT_MIRROR PIP_MIRROR NPM_MIRROR; do
  [[ -z "${!key:-}" ]] || args+=(--build-arg "$key=${!key}")
done
start=$SECONDS
nice -n 15 docker buildx build "${args[@]}" --output "type=oci,dest=$dest,tar=false" .
nice -n 15 docker buildx build "${args[@]}" --load -t "$tag" .
build_seconds=$((SECONDS-start))
sizes=$(./measure-image.sh "$tag" "$dest" "$limit")
loaded=$(docker image inspect --format '{{.Id}}' "$tag")
./scan-secrets.sh "$tag"
./smoke.sh "$tag"
docker run --rm --network none --entrypoint cat "$tag" /etc/oma/image-manifest.json > "$dest.manifest.json.pending"
node --input-type=module - "$dest" "$sizes" "$build_seconds" "$loaded" <<'JS'
import { verifyOciLayout, ociImageIds } from './boxlite-smoke.mjs';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
const [dir, sizes, seconds, loaded] = process.argv.slice(2);
const digest = await verifyOciLayout(dir);
// Smoke and scan ran on the loaded image, so it must be the layout's image.
if (!(await ociImageIds(dir)).includes(loaded)) throw Error('The loaded image differs from the OCI layout');
const { oci_bytes, rootfs_bytes } = JSON.parse(sizes);
const file = `${dir}.manifest.json`;
const manifest = JSON.parse(readFileSync(`${file}.pending`));
Object.assign(manifest, { image_digest: digest, size_bytes: oci_bytes, rootfs_bytes, build_seconds: Number(seconds) });
writeFileSync(`${file}.pending`, JSON.stringify(manifest, null, 2)+'\n');
renameSync(`${file}.pending`, file);
writeFileSync(`${dir}.digest`, digest+'\n', { flag: 'wx' });
console.log(JSON.stringify({directory: dir, ...manifest}, null, 2));
JS
