#!/bin/bash
# Usage: measure-image.sh TAG OCI_DIR LIMIT_BYTES
# The limit applies to the unpacked root filesystem, the size the VM disk
# holds. The OCI layout stores compressed layers and is about three times
# smaller, so it alone would hide a bloated image.
set -euo pipefail
tag=${1:?Usage: measure-image.sh TAG OCI_DIR LIMIT_BYTES}
dir=${2:?Usage: measure-image.sh TAG OCI_DIR LIMIT_BYTES}
limit=${3:?Usage: measure-image.sh TAG OCI_DIR LIMIT_BYTES}
oci=$(du -sb "$dir" | cut -f1)
rootfs=$(docker run --rm --network none --entrypoint /bin/sh "$tag" -c 'du -sxb / 2>/dev/null | cut -f1')
[[ "$oci" =~ ^[0-9]+$ && "$rootfs" =~ ^[0-9]+$ ]] || { echo 'Cannot measure the image size' >&2; exit 2; }
for bytes in "$oci" "$rootfs"; do
  if (( bytes > limit )); then echo "Image exceeds size limit: $bytes > $limit" >&2; exit 1; fi
done
printf '{"oci_bytes":%s,"rootfs_bytes":%s}\n' "$oci" "$rootfs"
