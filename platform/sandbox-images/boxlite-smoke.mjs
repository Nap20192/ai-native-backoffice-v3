#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

export async function verifyOciLayout(directory) {
  const layout = JSON.parse(await readFile(join(directory, 'oci-layout'), 'utf8'));
  if (layout.imageLayoutVersion !== '1.0.0') throw Error('Unsupported OCI layout');
  const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'));
  if (index.schemaVersion !== 2 || index.manifests?.length !== 1) {
    throw Error('Expected one OCI image. Build with provenance and SBOM disabled.');
  }
  const seen = new Set();
  let images = 0;
  async function verify(descriptor) {
    if (!/^sha256:[a-f0-9]{64}$/.test(descriptor.digest) || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
      throw Error('Invalid OCI descriptor');
    }
    const file = join(directory, 'blobs', 'sha256', descriptor.digest.slice(7));
    if ((await stat(file)).size !== descriptor.size) throw Error('OCI blob size mismatch');
    if (seen.has(descriptor.digest)) return;
    seen.add(descriptor.digest);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (`sha256:${hash.digest('hex')}` !== descriptor.digest) throw Error('OCI blob digest mismatch');
    const type = descriptor.mediaType;
    if (type?.includes('manifest') || type?.includes('index')) {
      if (descriptor.size > 8 * 1024 * 1024) throw Error('Oversized OCI metadata');
      const metadata = JSON.parse(await readFile(file, 'utf8'));
      if (metadata.config) {
        images++;
        await verify(metadata.config);
        const configFile = join(directory, 'blobs', 'sha256', metadata.config.digest.slice(7));
        const config = JSON.parse(await readFile(configFile, 'utf8'));
        if (config.os !== 'linux' || config.architecture !== 'amd64') throw Error('Expected linux/amd64');
        for (const layer of metadata.layers ?? []) await verify(layer);
      } else {
        for (const child of metadata.manifests ?? []) await verify(child);
      }
    }
  }
  await verify(index.manifests[0]);
  if (images !== 1) throw Error('Expected exactly one runnable image');
  return index.manifests[0].digest;
}

/** Manifest and config digests of the layout's image, the two ids Docker may report. */
export async function ociImageIds(directory) {
  const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'));
  const digest = index.manifests[0].digest;
  const manifest = JSON.parse(await readFile(join(directory, 'blobs', 'sha256', digest.slice(7)), 'utf8'));
  return [digest, manifest.config.digest];
}

// BoxLite binds <home>/boxes/<id>/sockets/ready.sock, and a Unix socket path
// holds at most 107 bytes. Runtime homes therefore live under a short path.
const SOCKET_SUFFIX = '/boxes/NswqLciUjgk2/sockets/ready.sock';
export function runtimeHome(cache, runId, name) {
  const home = join(cache, 'bx', runId, name);
  if (Buffer.byteLength(home + SOCKET_SUFFIX) > 107) {
    throw Error(`BoxLite socket path would exceed 107 bytes under ${home}`);
  }
  return home;
}

// boxlite-shim is a static glibc build: its cgo resolver loads the host NSS
// modules and crashes on the first guest DNS lookup. The LiteBox adapter sets
// GODEBUG=netdns=go while a box boots (applyShimDnsWorkaround in litebox.ts).
export function shimGodebug(current) {
  const value = current ?? '';
  if (/(^|,)\s*netdns=/.test(value)) return value;
  return value.trim() ? `${value},netdns=go` : 'netdns=go';
}

function checked(result) {
  if (result.exitCode !== 0) throw Error(result.stderr || `Guest command failed: ${result.exitCode}`);
  return result;
}

export async function benchmark(createBox) {
  const results = { cold: [], warm: [], concurrent: [] };
  async function run(phase, number) {
    const start = performance.now();
    const box = await createBox(phase, number);
    try {
      checked(await box.exec('/bin/bash', ['-c', 'true'], undefined, { timeoutSecs: 60 }));
      return { run: number, ready_ms: performance.now() - start };
    } finally { await box.stop(); }
  }
  for (let i = 0; i < 5; i++) results.cold.push(await run('cold', i));
  await run('warm', -1);
  for (let i = 0; i < 5; i++) results.warm.push(await run('warm', i));
  const concurrent = await Promise.allSettled(Array.from({ length: 3 }, (_, i) => run('concurrent', i)));
  for (const result of concurrent) {
    if (result.status === 'rejected') throw result.reason;
    results.concurrent.push(result.value);
  }
  return results;
}

async function main() {
  const directory = await realpath(resolve(process.argv[2] ?? ''));
  const cache = resolve(homedir(), '.cache/ai-backoffice-v3/environments');
  if (relative(cache, directory).startsWith('..') || !directory.startsWith(`${cache}/`)) {
    throw Error('OCI directory must be inside the environment cache');
  }
  const digest = await verifyOciLayout(directory);
  const manifest = JSON.parse(await readFile(`${directory}.manifest.json`, 'utf8'));
  if (manifest.image_digest !== digest) throw Error('Image manifest digest differs from OCI index');
  if (process.platform === 'linux' && !existsSync('/dev/kvm')) throw Error('/dev/kvm is unavailable');
  // The shim inherits the environment of this process.
  process.env.GODEBUG = shimGodebug(process.env.GODEBUG);
  const require = createRequire(new URL('../packages/sandbox-adapter-litebox/package.json', import.meta.url));
  const { JsBoxlite, SimpleBox } = await import(pathToFileURL(require.resolve('@boxlite-ai/boxlite')).href);
  const office = manifest.dpkg.some(({ name }) => name === 'libreoffice-writer-nogui');
  // Unrestricted network, as the adapter maps an unrestricted environment.
  const options = { rootfsPath: directory, cpus: 2, memoryMib: office ? 2048 : 1024,
    diskSizeGb: office ? 8 : 6, workingDir: '/workspace', user: '0:0', network: { mode: 'enabled' } };
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const runDir = join(cache, 'measurements', runId);
  await mkdir(runDir, { recursive: true });
  const runtimes = [];
  const runtimeFor = async (homeDir) => {
    await mkdir(homeDir, { recursive: true });
    const runtime = new JsBoxlite({ homeDir });
    runtimes.push(runtime);
    return runtime;
  };
  const warm = await runtimeFor(runtimeHome(cache, runId, 'w'));
  const report = { image_digest: digest, size_bytes: manifest.size_bytes, options, notDone: [] };
  try {
    report.starts = await benchmark(async (phase, number) => new SimpleBox({ ...options,
      runtime: phase === 'cold' ? await runtimeFor(runtimeHome(cache, runId, `c${number}`)) : warm,
    }));
    const box = new SimpleBox({ ...options, runtime: warm });
    try {
      checked(await box.exec('/bin/bash', ['-euc', [
        'python --version',
        'python3 -c "import pptx, docx, openpyxl, pypdf, pdfplumber, reportlab, pandas, matplotlib, bs4, lxml, requests; import sys; assert sys.prefix == \'/opt/venv\'"',
        'python -m pip install --no-cache-dir tomli-w==1.2.0',
        'python -c "import tomli_w; assert tomli_w.__file__.startswith(\'/opt/venv/\')"',
        'test -n "$(fc-list :lang=ru)"',
      ].join('\n')], undefined, { timeoutSecs: 120 }));
      const peaks = [];
      let samplingError;
      let sampling = Promise.resolve();
      const timer = setInterval(() => {
        sampling = sampling.then(async () => {
          const metrics = await box.metrics();
          if (metrics.memoryBytes !== undefined) peaks.push(metrics.memoryBytes);
        }).catch((error) => { samplingError = error.message; });
      }, 100);
      let render;
      try {
        render = checked(await box.exec('python3', ['/opt/oma/selftest/render-ru.py', '--json', '--workloads'], undefined, { timeoutSecs: 300 }));
      } finally { clearInterval(timer); await sampling; }
      report.render = JSON.parse(render.stdout);
      report.memory_peak_sampled_bytes = peaks.length ? Math.max(...peaks) : null;
      report.memory_sampling_interval_ms = 100;
      if (!peaks.length || samplingError) report.notDone.push(`VM memory sampling unavailable: ${samplingError ?? 'no samples'}`);
    } finally { await box.stop(); }
    const limits = { cold: 30000, warm: office ? 8000 : 5000 };
    report.limit_failures = Object.entries(limits).flatMap(([phase, max]) =>
      report.starts[phase].filter(({ ready_ms }) => ready_ms > max).map((r) => `${phase}/${r.run} exceeds ${max} ms`));
    if (report.memory_peak_sampled_bytes > options.memoryMib * 1024 ** 2 * 0.7) report.limit_failures.push('Memory peak exceeds 70% of catalog allocation');
    if (report.limit_failures.length || report.notDone.length) process.exitCode = 1;
  } catch (error) {
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    await Promise.allSettled(runtimes.map((runtime) => runtime.shutdown(10)));
    await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2)+'\n');
    console.log(JSON.stringify({ report: join(runDir, 'report.json'), ...report }, null, 2));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
