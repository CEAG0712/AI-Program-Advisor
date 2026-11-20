import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import type { OnModuleDestroy } from '@nestjs/common';
import { compareRankingCandidates, MAX_RECOMMENDATIONS } from './recommendations.policy.js';
import { rankingUnavailable, validateRankingCandidates, type OfferRanker, type RankingCandidate } from './ranking.js';

const PROTOCOL_VERSION = 1;
const MAX_PROCESSES = 2;
const DEADLINE_MS = 500;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 10 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;

function parseRanking(bytes: Buffer, expectedIds: readonly string[]): string[] {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const response: unknown = JSON.parse(text);
  if (response === null || typeof response !== 'object' || Array.isArray(response) ||
      !('protocol_version' in response) || response.protocol_version !== PROTOCOL_VERSION ||
      !('ordered_offer_ids' in response) || !Array.isArray(response.ordered_offer_ids) ||
      Object.keys(response).length !== 2) throw rankingUnavailable();

  // JSON.parse collapses repeated keys. Count member names outside string values too.
  const memberNames = [...text.matchAll(/"(?:[^"\\]|\\[\s\S])*"\s*(:)?/g)].filter((token) => token[1]);
  const ids: unknown[] = response.ordered_offer_ids;
  // Exact positional equality to the unique, validated top ten proves membership and uniqueness.
  if (memberNames.length !== 2 || ids.length !== expectedIds.length ||
      !ids.every((id, index) => id === expectedIds[index])) throw rankingUnavailable();
  return ids as string[];
}

export class RustRanker implements OfferRanker, OnModuleDestroy {
  private readonly running = new Map<() => void, Promise<readonly string[]>>();
  private stopping = false;

  constructor(private readonly executablePath: string) {
    if (typeof executablePath !== 'string' || !isAbsolute(executablePath) || executablePath.includes('\0')) {
      throw new Error('Rust ranker requires a server-configured absolute executable path.');
    }
  }

  async rank(offers: readonly RankingCandidate[], signal?: AbortSignal): Promise<readonly string[]> {
    signal?.throwIfAborted();
    if (this.stopping || this.running.size >= MAX_PROCESSES) throw rankingUnavailable();
    validateRankingCandidates(offers);
    const projected = offers.map(({ offer_id, price_cents, weekly_study_hours }) =>
      ({ offer_id, price_cents, weekly_study_hours }));
    const payload = Buffer.from(JSON.stringify({ protocol_version: PROTOCOL_VERSION, offers: projected }));
    if (payload.length > MAX_REQUEST_BYTES) throw rankingUnavailable();
    const expectedIds = projected.sort(compareRankingCandidates).slice(0, MAX_RECOMMENDATIONS).map((offer) => offer.offer_id);
    const deadline = performance.now() + DEADLINE_MS;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.executablePath, [], { shell: false, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      throw rankingUnavailable();
    }
    const { promise, resolve, reject } = Promise.withResolvers<readonly string[]>();
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: { reason: unknown } | undefined;

    const terminate = (reason: unknown) => {
      if (failure) return;
      failure = { reason };
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      // Drop the pipes as well, including when a broken executable leaves them open.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const stop = () => terminate(rankingUnavailable());
    const abort = () => terminate(signal?.reason);
    const timer = setTimeout(stop, Math.ceil(deadline - performance.now()));
    this.running.set(stop, promise);

    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.running.delete(stop);
      if (failure) {
        reject(failure.reason);
        return;
      }
      try {
        if (code !== 0 || exitSignal !== null || !child.stdin.writableFinished || performance.now() >= deadline) {
          throw rankingUnavailable();
        }
        resolve(parseRanking(Buffer.concat(stdout, stdoutBytes), expectedIds));
      } catch {
        reject(rankingUnavailable());
      }
    });
    child.on('error', stop);
    child.stdin.on('error', stop);
    child.stdout.on('error', stop);
    child.stderr.on('error', stop);
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) stop();
      else stdout.push(chunk);
    });
    // Drain diagnostics and enforce their byte ceiling without retaining or logging their content.
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) stop();
    });
    signal?.addEventListener('abort', abort, { once: true });
    try {
      child.stdin.end(payload);
    } catch {
      stop();
    }
    return promise;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    const active = [...this.running];
    for (const [stop] of active) stop();
    await Promise.allSettled(active.map(([, completion]) => completion));
  }
}
