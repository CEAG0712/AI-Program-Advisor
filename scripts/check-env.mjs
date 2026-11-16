import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let failed = false;

/** @param {string} command @param {string[]} args */
function run(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 65536,
    env: {
      ...process.env,
      NODE_DISABLE_COMPILE_CACHE: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

/** @param {ReturnType<typeof run>} result */
function dockerFailure(result) {
  const code = result.error && 'code' in result.error ? result.error.code : undefined;
  if (code === 'ETIMEDOUT') return 'TIMEOUT';
  if (code === 'EACCES' || code === 'EPERM') return 'ACCESS_DENIED';
  // Inspect stderr only to select fixed categories; never print it or endpoints.
  const detail = result.stderr ?? '';
  if (/permission denied|access (?:is )?denied|operation not permitted/i.test(detail)) {
    return 'ACCESS_DENIED';
  }
  if (/timed out|i\/o timeout|context deadline exceeded/i.test(detail)) return 'TIMEOUT';
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOENT'].includes(String(code)) ||
      /cannot connect to the docker daemon|connection refused|connection reset|no such file or directory/i.test(detail)) {
    return 'CONNECTION_UNAVAILABLE';
  }
  return 'UNKNOWN_FAILURE';
}

/** @param {string} name */
function available(name) {
  return (process.env.PATH ?? '').split(delimiter).some((directory) => {
    if (!directory) return false;
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** @param {string} label @param {boolean} ok @param {string} detail */
function required(label, ok, detail) {
  console.log(`REQUIRED NOW | ${label}: ${ok ? 'PASS' : 'FAIL'} | ${detail}`);
  if (!ok) failed = true;
}

console.log('P3 D1.1 environment inspection; no services are started.');
required('Node', Number(process.versions.node.split('.')[0]) === 24, process.version);
const npm = run('npm', ['--version']);
const npmVersion = npm.stdout?.trim() ?? '';
required('npm', npm.status === 0 && /^11\./.test(npmVersion),
  /^\d+\.\d+\.\d+$/.test(npmVersion) ? npmVersion : 'MISSING or unavailable');
const git = run('git', ['--version']);
required('Git', git.status === 0, git.status === 0 ? git.stdout.trim() : 'MISSING or unavailable');
const gitRoot = run('git', ['rev-parse', '--show-toplevel']);
const sameRoot = gitRoot.status === 0 && realpathSync(gitRoot.stdout.trim()) === realpathSync(root);
required('repository root', sameRoot, sameRoot ? 'matches harness directory' : 'MISSING or different repository');
if (sameRoot) {
  const branch = run('git', ['symbolic-ref', '--short', 'HEAD']);
  const head = run('git', ['rev-parse', '--verify', 'HEAD']);
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  required('Git state inspection', status.status === 0, status.status === 0
    ? `${status.stdout.trim() ? status.stdout.trim().split('\n').length : 0} pending paths` : 'unavailable');
  console.log(`INFO | branch: ${branch.status === 0 ? branch.stdout.trim() : 'detached or UNKNOWN'}`);
  console.log(`INFO | HEAD: ${head.status === 0 ? head.stdout.trim() : 'no commit yet'}`);
}

const docker = run('docker', ['--version']);
console.log(`REQUIRED LATER | Docker CLI: ${docker.status === 0 ? docker.stdout.trim() : 'MISSING or unavailable'}`);
if (docker.status === 0) {
  const compose = run('docker', ['compose', 'version', '--short']);
  console.log(`REQUIRED LATER | Docker Compose: ${compose.status === 0 ? compose.stdout.trim() : 'MISSING or unavailable'}`);
  // Context inspection reads local metadata only. Never query a TCP/SSH endpoint.
  let endpoint = '';
  if (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) {
    endpoint = process.env.DOCKER_HOST;
  } else {
    const context = run('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']);
    if (context.status === 0) {
      try {
        const parsed = JSON.parse(context.stdout);
        if (typeof parsed === 'string') endpoint = parsed;
      } catch { /* Leave unresolved; never print raw configuration. */ }
    }
  }
  if (endpoint.startsWith('unix:///')) {
    const daemon = run('docker', ['--host', endpoint, 'info', '--format', '{{.ServerVersion}}']);
    const diagnostic = daemon.status === 0 ? 'AVAILABLE' : dockerFailure(daemon);
    console.log(`REQUIRED LATER | Docker daemon query: ${diagnostic} via local Unix socket`);
    if (daemon.status !== 0) console.log('UNKNOWN | Docker daemon state: query failure does not establish service state');
  } else {
    console.log('UNKNOWN | Docker daemon: query skipped; endpoint is nonlocal or unresolved');
  }
} else {
  console.log('UNKNOWN | Docker daemon and Compose: CLI unavailable');
}

for (const tool of ['rustc', 'cargo', 'terraform']) {
  console.log(`REQUIRED LATER | ${tool}: ${available(tool) ? 'AVAILABLE on PATH; functionality unverified' : 'MISSING'}`);
}
for (const tool of ['psql', 'tflocal', 'awslocal', 'localstack']) {
  console.log(`OPTIONAL | ${tool}: ${available(tool) ? 'AVAILABLE on PATH; functionality unverified' : 'MISSING'}`);
}
console.log('UNKNOWN | PostgreSQL runtime: unresolved; no database connection attempted');
console.log('UNKNOWN | LocalStack Base compatibility/entitlement: unverified; no API calls made');
console.log(`D1.1 harness: ${failed ? 'FAIL' : 'PASS'}; application/database readiness is not established.`);
process.exitCode = failed ? 1 : 0;
