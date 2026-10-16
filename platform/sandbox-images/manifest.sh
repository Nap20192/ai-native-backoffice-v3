#!/bin/sh
set -eu
# A pinned foreign image can use this script through stdin without installing it.
if [ "$#" -eq 1 ]; then
  case "$1" in *@sha256:*) ;; *) echo 'A digest-pinned image is required' >&2; exit 2;; esac
  exec docker run --rm -i -e "OMA_IMAGE_DIGEST=${1##*@}" --entrypoint /bin/sh "$1" -s < "$0"
fi
python3 - <<'PY'
import json, os, platform, shutil, subprocess
from pathlib import Path

def output(args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL).strip()

def optional(args):
    try:
        return output(args)
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None

os_release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
pip_python = '/opt/venv/bin/python' if Path('/opt/venv/bin/python').exists() else 'python3'
pip = optional([pip_python, '-m', 'pip', 'list', '--format=json'])
npm = optional(['npm', 'ls', '-g', '--depth=0', '--json'])
dpkg = output(['dpkg-query', '-W', '-f', '${Package}\t${Version}\n'])
fonts = optional(['fc-list', '--format', '%{family}\t%{file}\n', ':lang=ru'])
print(json.dumps({
    'schema_version': 1,
    'image_digest': os.environ.get('OMA_IMAGE_DIGEST'),
    'os': {key.lower(): value.strip('"') for key, value in os_release.items()},
    'architecture': platform.machine(), 'user': output(['id', '-un']),
    'shell': '/bin/bash' if Path('/bin/bash').exists() else '/bin/sh',
    'venv': '/opt/venv' if Path('/opt/venv').exists() else None,
    'python_version': platform.python_version(), 'node_version': optional(['node', '--version']),
    'package_managers': [name for name in ['apt-get', 'npm', 'pip', 'uv'] if shutil.which(name)],
    'pip': json.loads(pip) if pip else [],
    'dpkg': [dict(zip(['name', 'version'], line.split('\t'))) for line in dpkg.splitlines()],
    'npm': json.loads(npm).get('dependencies', {}) if npm else {},
    'fonts': fonts.splitlines() if fonts else [],
    'uv_version': optional(['uv', '--version']),
    'libreoffice_version': optional(['soffice', '--version']),
}, ensure_ascii=False, indent=2))
PY
