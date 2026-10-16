#!/bin/sh
set -eu
exec python3 - "${1:?Usage: scan-secrets.sh IMAGE}" <<'PY'
import io, json, re, subprocess, sys, tarfile

tag = sys.argv[1]
url_userinfo = re.compile(rb'://[^\s/"<>]+@')
pattern = re.compile(rb'(?i)://[^\s/"<>]+@|(?:token|password)\s*=\s*[^\s;"\x27]+|_authToken\s*[:=]\s*[^\s,"\x27]+')
netrc = re.compile(rb'(?i)\bpassword\s+\S')
# Files where a mirror, registry or proxy credential lands. Elsewhere under
# etc/ base image files name password options in examples, so only an address
# with a login counts there.
config_files = ('etc/pip.conf', 'etc/npmrc', 'etc/environment', 'etc/apt/sources.list',
                'usr/local/etc/npmrc', 'opt/venv/pip.conf', 'root/.npmrc', 'root/.pypirc',
                'root/.bash_history')
config_dirs = ('etc/uv/', 'etc/apt/sources.list.d/', 'etc/profile.d/', 'etc/oma/',
               'root/.config/pip/', 'root/.config/uv/', 'root/.docker/', 'root/.npm/_logs/',
               'root/.cache/pip/')
netrc_files = ('etc/apt/auth.conf', 'root/.netrc')

def layer_pattern(path):
    if path in netrc_files or path.startswith('etc/apt/auth.conf.d/'):
        return netrc
    if path in config_files or path.startswith(config_dirs):
        return pattern
    if path.startswith('etc/'):
        return url_userinfo
    return None

def check(data, source, regex=pattern):
    if regex.search(data):
        # Print only the location, never the matching secret.
        raise RuntimeError('Possible credential in ' + source)

for args, label in [(['inspect', tag], 'image config'), (['history', '--no-trunc', tag], 'image history')]:
    check(subprocess.check_output(['docker', *args]), label)

proc = subprocess.Popen(['docker', 'save', tag], stdout=subprocess.PIPE)
try:
    with tarfile.open(fileobj=proc.stdout, mode='r|*') as archive:
        for item in archive:
            if not item.isfile():
                continue
            if item.name.endswith('.json'):
                if item.size > 8*1024*1024:
                    raise RuntimeError('Oversized image metadata')
                check(archive.extractfile(item).read(), 'saved metadata')
            elif item.name.endswith('/layer.tar') or item.name.startswith('blobs/'):
                stream = archive.extractfile(item)
                # docker save can use either the legacy layout or OCI blobs.
                head = stream.read(512)
                if head.lstrip().startswith(b'{'):
                    check(head + stream.read(), 'saved config')
                    continue
                class Prefix(io.RawIOBase):
                    def read(self, n=-1):
                        first, self.first = self.first, b''
                        if n < 0: return first + stream.read()
                        if len(first) >= n:
                            self.first = first[n:]
                            return first[:n]
                        return first + stream.read(n-len(first))
                wrapped = Prefix()
                wrapped.first = head
                with tarfile.open(fileobj=wrapped, mode='r|*') as layer:
                    for entry in layer:
                        path = entry.name.lstrip('./')
                        regex = layer_pattern(path)
                        if entry.isfile() and regex is not None:
                            if entry.size > 8*1024*1024:
                                raise RuntimeError('Oversized configuration in layer')
                            check(layer.extractfile(entry).read(), 'layer configuration ' + path, regex)
    if proc.wait() != 0:
        raise RuntimeError('docker save failed')
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
print('No credentials found in image metadata, history or layer configuration')
PY
