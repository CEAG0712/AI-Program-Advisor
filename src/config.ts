export interface Config {
  readonly databaseUrl: string;
  readonly tokenA: string;
  readonly tokenB: string;
  readonly port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL ?? '';
  const tokenA = env.P3_DEMO_TOKEN_A ?? '';
  const tokenB = env.P3_DEMO_TOKEN_B ?? '';
  const port = Number(env.PORT ?? '3000');
  try {
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.pathname !== '/p3_d12' || url.username !== 'p3_d12' ||
        !url.password || url.search || url.hash) throw new Error();
  } catch {
    throw new Error('DATABASE_URL must identify the isolated local p3_d12 database; configuration values are redacted.');
  }
  if (![tokenA, tokenB].every((token) => /^[A-Za-z0-9_-]{32,256}$/.test(token)) || tokenA === tokenB) {
    throw new Error('Configure two distinct demo credentials of 32–256 URL-safe characters.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid local TCP port.');
  return Object.freeze({ databaseUrl, tokenA, tokenB, port });
}
