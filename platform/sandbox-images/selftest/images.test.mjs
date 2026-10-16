import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { verifyOciLayout, benchmark, ociImageIds, runtimeHome, shimGodebug } from '../boxlite-smoke.mjs';

const root = new URL('../', import.meta.url);
const run = (program, args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(program, args, {
    env: { ...process.env, ...env }, timeout: 5000,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});
const build = (env) => run('bash', [new URL('build.sh', root).pathname, 'workplace', 'test'], env);

describe('image build boundary', () => {
  for (const mirror of ['https://user:secret@example.org/simple', 'https://example.org/?token=x',
    'https://example.org/#x', 'file:///etc/passwd', 'https://example.org/%40secret', 'https://example.org/\nRUN x']) {
    it(`rejects an unsafe mirror ${JSON.stringify(mirror)}`, async () => {
      const result = await build({ PIP_MIRROR: mirror });
      expect(result.status).not.toBe(0);
      expect(result.stderr, JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout })).toContain('Invalid PIP_MIRROR');
      expect(result.stderr).not.toContain('user:secret');
    });
  }
  it('rejects artifacts outside the environment cache before contacting Docker', async () => {
    const result = await build({ SANDBOX_IMAGE_DIR: '/tmp/should-not-build' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SANDBOX_IMAGE_DIR must be inside');
  });
  it('refuses an existing version without touching Docker', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ex1-version-'));
    try {
      // The default image folder matches SANDBOX_IMAGE_DIR in the plan and launch.sh.
      mkdirSync(join(home, '.cache/ai-backoffice-v3/environments/sandbox-images/workplace-test'), { recursive: true });
      mkdirSync(join(home, 'bin'));
      writeFileSync(join(home, 'bin', 'docker'), `#!/bin/sh\ntouch "${home}/docker-called"\nexit 1\n`, { mode: 0o755 });
      const result = await build({ HOME: home, PATH: `${join(home, 'bin')}:${process.env.PATH}` });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Image version already exists');
      expect(existsSync(join(home, 'docker-called'))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('image size limit', () => {
  async function measure(rootfsBytes, limit) {
    const dir = mkdtempSync(join(tmpdir(), 'ex1-size-'));
    try {
      mkdirSync(join(dir, 'oci'));
      writeFileSync(join(dir, 'oci', 'blob'), Buffer.alloc(1000));
      // The fake docker answers the rootfs measurement inside the container.
      writeFileSync(join(dir, 'docker'), '#!/bin/sh\necho "$*" > "$FAKE_LOG"\necho "$FAKE_ROOTFS"\n', { mode: 0o755 });
      const result = await run('bash', [new URL('measure-image.sh', root).pathname, 'oma/test:1', join(dir, 'oci'), String(limit)], {
        PATH: `${dir}:${process.env.PATH}`, FAKE_ROOTFS: String(rootfsBytes), FAKE_LOG: join(dir, 'log'),
      });
      return { ...result, docker: readFileSync(join(dir, 'log'), 'utf8') };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it('limits the unpacked root filesystem, not only the compressed OCI layout', async () => {
    const result = await measure(2500, 2000);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Image exceeds size limit');
    expect(result.docker).toContain('--network none');
    expect(result.docker).toContain('du -sxb /');
  });
  it('reports both sizes within the limit', async () => {
    const result = await measure(1500, 2000);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ oci_bytes: 1000, rootfs_bytes: 1500 });
  });
  it('fails on an unreadable measurement', async () => {
    const result = await measure('du: cannot read', 2000);
    expect(result.status).not.toBe(0);
  });
});

describe('secret scan', () => {
  async function scan(payload, layout = 'legacy', file = 'etc/pip.conf') {
    const dir = mkdtempSync(join(tmpdir(), 'ex1-scan-'));
    try {
      // Tiny synthetic archive, no image or package data.
      const fixture = await run('python3', ['-c', `
import io, tarfile, sys
from pathlib import Path
directory, payload, layout, name = sys.argv[1:]
layer = io.BytesIO()
with tarfile.open(fileobj=layer, mode='w') as tar:
    data = payload.encode()
    info = tarfile.TarInfo(name); info.size = len(data)
    tar.addfile(info, io.BytesIO(data))
with tarfile.open(Path(directory) / 'image.tar', mode='w') as tar:
    info = tarfile.TarInfo('layer/layer.tar' if layout == 'legacy' else 'blobs/sha256/fixture')
    info.size = len(layer.getvalue()); tar.addfile(info, io.BytesIO(layer.getvalue()))
`, dir, payload, layout, file]);
      expect(fixture.status).toBe(0);
      writeFileSync(join(dir, 'docker'), '#!/bin/sh\ncase "$1" in\ninspect) echo "{}";;\nhistory) echo "safe history";;\nsave) cat "$SCAN_FIXTURE";;\nesac\n', { mode: 0o755 });
      return await run('sh', [new URL('scan-secrets.sh', root).pathname, 'fixture'], {
        PATH: `${dir}:${process.env.PATH}`, SCAN_FIXTURE: join(dir, 'image.tar'),
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  for (const layout of ['legacy', 'oci']) {
    it(`detects credentials in a ${layout} layer without printing their value`, async () => {
      const result = await scan('index-url = https://alice:canary-private@mirror.example/simple', layout);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Possible credential');
      expect(result.stderr).not.toContain('canary-private');
    });
    it(`accepts credential-free ${layout} layer configuration`, async () => {
      const result = await scan('index-url = https://mirror.example/simple', layout);
      expect(result.status, result.stderr).toBe(0);
    });
  }
  // Lines from node:22-bookworm that only name a password option.
  for (const [file, text] of [
    ['etc/ImageMagick-6/delegates.xml', '<delegate command="&quot;gs&quot; -sPDFPassword=&quot;%a&quot;"/>'],
    ['etc/ssl/openssl.cnf', 'challengePassword\t\t= A challenge password'],
    ['etc/subversion/servers', '# http-proxy-password = defaultpassword'],
  ]) {
    it(`accepts the base image file ${file}`, async () => {
      const result = await scan(text, 'oci', file);
      expect(result.status, result.stderr).toBe(0);
    });
  }
  for (const [file, text] of [
    ['usr/local/etc/npmrc', '//registry.example/:_authToken=canary-private'],
    ['opt/venv/pip.conf', 'index-url = https://alice:canary-private@mirror.example/simple'],
    ['etc/apt/auth.conf.d/mirror.conf', 'machine mirror.example login alice password canary-private'],
    ['etc/uv/uv.toml', 'index-url = "https://mirror.example/simple?token=canary-private"'],
    ['etc/default/proxy', 'url=https://alice:canary-private@proxy.example'],
  ]) {
    it(`detects credentials in ${file}`, async () => {
      const result = await scan(text, 'oci', file);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Possible credential');
      expect(result.stderr).not.toContain('canary-private');
    });
  }
});

describe('OCI verification', () => {
  it('checks the selected image and every referenced blob, including layer bytes', async () => {
    // Small metadata fixtures only. Image data never goes into tmpdir.
    const dir = mkdtempSync(join(tmpdir(), 'ex1-test-'));
    mkdirSync(join(dir, 'blobs/sha256'), { recursive: true });
    const blob = (value, mediaType) => {
      const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      const hex = createHash('sha256').update(bytes).digest('hex');
      writeFileSync(join(dir, 'blobs/sha256', hex), bytes);
      return { digest: `sha256:${hex}`, size: bytes.length, mediaType };
    };
    try {
      const layer = blob('fixture layer', 'application/vnd.oci.image.layer.v1.tar');
      const config = blob({ architecture: 'amd64', os: 'linux' }, 'application/vnd.oci.image.config.v1+json');
      const manifest = blob({ schemaVersion: 2, config, layers: [layer] }, 'application/vnd.oci.image.manifest.v1+json');
      writeFileSync(join(dir, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
      writeFileSync(join(dir, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [manifest] }));
      expect(await verifyOciLayout(dir)).toBe(manifest.digest);
      // docker image inspect reports either id, depending on the image store.
      expect(await ociImageIds(dir)).toEqual([manifest.digest, config.digest]);
      writeFileSync(join(dir, 'blobs/sha256', layer.digest.slice(7)), 'fixture layeR');
      await expect(verifyOciLayout(dir)).rejects.toThrow(/digest|size/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('VM measurements', () => {
  it('makes boxlite-shim resolve guest DNS in Go, as the LiteBox adapter does', () => {
    // Without netdns=go the static shim loads host NSS modules and crashes on the first lookup.
    expect(shimGodebug(undefined)).toBe('netdns=go');
    expect(shimGodebug('')).toBe('netdns=go');
    expect(shimGodebug('http2client=0')).toBe('http2client=0,netdns=go');
    expect(shimGodebug('netdns=cgo+2')).toBe('netdns=cgo+2');
  });
  it('keeps the BoxLite socket path under the Unix limit', () => {
    // BoxLite binds <home>/boxes/<12 chars>/sockets/ready.sock; sun_path holds 107 bytes.
    const cache = '/home/vnkjd/.cache/ai-backoffice-v3/environments';
    const home = runtimeHome(cache, 'mfz3k2ab', 'cold-4');
    expect(home.startsWith(`${cache}/`)).toBe(true);
    expect(Buffer.byteLength(`${home}/boxes/NswqLciUjgk2/sockets/ready.sock`)).toBeLessThanOrEqual(107);
    expect(() => runtimeHome(`/home/${'x'.repeat(60)}/.cache/ai-backoffice-v3/environments`, 'mfz3k2ab', 'cold-4'))
      .toThrow(/socket path/);
  });

  it('runs five cold, five warm and three concurrent VMs and always stops them', async () => {
    const boxes = [];
    const result = await benchmark(async (phase, run) => {
      const box = {
        exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
        stop: async () => { box.stopped = true; },
      };
      boxes.push({ phase, run, box });
      return box;
    });
    expect(result.cold).toHaveLength(5);
    expect(result.warm).toHaveLength(5);
    expect(result.concurrent).toHaveLength(3);
    expect(boxes.every(({ box }) => box.stopped)).toBe(true);
  });
  it('stops a VM when its first exec fails', async () => {
    let stopped = 0;
    await expect(benchmark(async () => ({
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'boot failed' }),
      stop: async () => { stopped++; },
    }))).rejects.toThrow('boot failed');
    expect(stopped).toBe(1);
  });
});

it('keeps legacy as default and pins Python dependencies', () => {
  const catalog = JSON.parse(readFileSync(new URL('catalog.json', root)));
  expect(catalog.default_image).toBe('legacy');
  expect(catalog.images.legacy.image).toMatch(/@sha256:[a-f0-9]{64}$/);
  const requirements = readFileSync(new URL('requirements-workplace.txt', root), 'utf8');
  for (const line of requirements.trim().split('\n').filter((line) => !line.startsWith('#'))) {
    expect(line).toMatch(/^[A-Za-z0-9_.-]+==[0-9][A-Za-z0-9.]*$/);
  }
});

it('pins every external base image by digest', () => {
  const dockerfile = readFileSync(new URL('Dockerfile', root), 'utf8');
  const external = dockerfile.split('\n').filter((line) => /^FROM /.test(line) && !/^FROM workplace /.test(line));
  expect(external.length).toBeGreaterThan(1);
  // A tag can move to other content; the digest cannot.
  for (const line of external) expect(line).toMatch(/^FROM \S+@sha256:[a-f0-9]{64} AS \w+$/);
});

it('installs only the pinned Python packages and checks that the set is closed', () => {
  const dockerfile = readFileSync(new URL('Dockerfile', root), 'utf8');
  // Without --no-deps pip resolves an unlisted dependency to its newest release.
  expect(dockerfile).toMatch(/pip install --no-cache-dir --no-deps -r \/opt\/oma\/requirements-workplace\.txt/);
  expect(dockerfile).toMatch(/\/opt\/venv\/bin\/python -m pip check/);
  const pinned = readFileSync(new URL('requirements-workplace.txt', root), 'utf8').toLowerCase();
  // reportlab requires chardet, requests supports chardet below 6.
  expect(pinned).toMatch(/^chardet==5\./m);
});

it('preserves the venv when Python is called through /usr/local/bin links', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ex1-python-'));
  try {
    const result = await run('python3', ['-c', `
import os, pathlib, subprocess, sys, venv
root = pathlib.Path(sys.argv[1])
venv.create(root / 'venv', with_pip=False, system_site_packages=True)
script = pathlib.Path(sys.argv[2]).read_text().replace('/opt/venv', str(root / 'venv'))
(root / 'entrypoint').write_text(script); (root / 'entrypoint').chmod(0o755)
(root / 'bin').mkdir()
for name in ['python', 'python3']:
    executable = root / 'bin' / name
    executable.symlink_to(root / 'entrypoint')
    actual = subprocess.check_output([str(executable), '-c', 'import sys; print(sys.prefix)'], text=True).strip()
    assert actual == str(root / 'venv'), actual
`, dir, new URL('python-entrypoint.sh', root).pathname]);
    expect(result.status, result.stderr).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
