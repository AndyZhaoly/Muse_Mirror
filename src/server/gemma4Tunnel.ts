import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppConfig } from '../config.js';

export interface Gemma4EndpointStatus {
  ready: boolean;
  transport: 'not-required' | 'direct' | 'ssh-tunnel' | 'unavailable';
  message?: string;
}

let tunnelProcess: ChildProcess | undefined;

export async function ensureGemma4Endpoint(
  config: AppConfig,
): Promise<Gemma4EndpointStatus> {
  if (config.agentProvider !== 'gemma4') {
    return { ready: true, transport: 'not-required' };
  }

  if (await endpointAvailable(config.gemma4OllamaEndpoint)) {
    return { ready: true, transport: 'direct' };
  }

  if (!config.gemma4AutoTunnel) {
    return {
      ready: false,
      transport: 'unavailable',
      message: 'Gemma4 Ollama endpoint is not reachable.',
    };
  }

  const missing = requiredSshEnv().filter((name) => !process.env[name]);
  if (missing.length > 0) {
    return {
      ready: false,
      transport: 'unavailable',
      message: `Gemma4 SSH tunnel is not configured: ${missing.join(', ')}`,
    };
  }

  if (!endpointLooksLocal(config.gemma4OllamaEndpoint)) {
    return {
      ready: false,
      transport: 'unavailable',
      message: 'Auto tunnel only supports a localhost Ollama endpoint.',
    };
  }

  closeGemma4Tunnel();
  tunnelProcess = spawn(
    'sshpass',
    [
      '-e',
      'ssh',
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/tmp/codex_gemma4_known_hosts',
      '-L',
      `${config.gemma4TunnelLocalPort}:127.0.0.1:11434`,
      '-p',
      process.env.GEMMA4_SSH_PORT ?? '',
      `${process.env.GEMMA4_SSH_USER ?? ''}@${process.env.GEMMA4_SSH_HOST ?? ''}`,
    ],
    {
      env: { ...process.env, SSHPASS: process.env.GEMMA4_SSH_PASSWORD ?? '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );

  let exited = false;
  tunnelProcess.once('exit', () => {
    exited = true;
  });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await endpointAvailable(config.gemma4OllamaEndpoint)) {
      return { ready: true, transport: 'ssh-tunnel' };
    }
    if (exited) {
      closeGemma4Tunnel();
      return {
        ready: false,
        transport: 'unavailable',
        message: 'Gemma4 SSH tunnel exited before Ollama became reachable.',
      };
    }
    await delay(500);
  }

  closeGemma4Tunnel();
  return {
    ready: false,
    transport: 'unavailable',
    message: 'Timed out waiting for Gemma4 Ollama endpoint.',
  };
}

export function closeGemma4Tunnel(): void {
  if (!tunnelProcess || tunnelProcess.killed) return;
  tunnelProcess.kill('SIGTERM');
  tunnelProcess = undefined;
}

async function endpointAvailable(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function endpointLooksLocal(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function requiredSshEnv(): string[] {
  return [
    'GEMMA4_SSH_HOST',
    'GEMMA4_SSH_PORT',
    'GEMMA4_SSH_USER',
    'GEMMA4_SSH_PASSWORD',
  ];
}
