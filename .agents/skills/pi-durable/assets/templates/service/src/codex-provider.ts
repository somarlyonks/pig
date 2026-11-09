// Build with npm run build. Reuse the installed Pi account through its read-only auth command.
import { execFile } from 'node:child_process';
import { isAbsolute, extname } from 'node:path';
import type { AuthCheck, AuthResult, Provider } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';

const AUTH_TIMEOUT_MS = 15_000;
const AUTH_MAX_BYTES = 64 * 1024;
const AUTH_ERROR = 'Existing Pi Codex authentication is unavailable or expired. Sign in through Pi, then retry. No account refresh was requested by this service.';
type AuthStatus = { status: 'ready'; provider: 'openai-codex'; authType: 'oauth'; credentials?: string };

function authFailure(): Error { return new Error(AUTH_ERROR); }

function readOnlyAuth(piCliPath: string, withCredentials: boolean, signal: AbortSignal): Promise<AuthStatus> {
  // Never attach child errors as causes: execFile errors can contain secret stdout.
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(authFailure()); return; }
    const args = [piCliPath, 'auth', 'check', '--provider', 'openai-codex', '--no-refresh', '--json'];
    if (withCredentials) args.push('--credentials');
    execFile(process.execPath, args, {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: AUTH_TIMEOUT_MS,
      maxBuffer: AUTH_MAX_BYTES, signal,
      env: { ...process.env, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
    }, (error, stdout) => {
      if (error) { reject(authFailure()); return; }
      try {
        const result: unknown = JSON.parse(stdout.trim());
        if (!result || typeof result !== 'object') throw authFailure();
        const status = result as Record<string, unknown>;
        if (status.status !== 'ready' || status.provider !== 'openai-codex' || status.authType !== 'oauth') throw authFailure();
        if (withCredentials) {
          if (typeof status.credentials !== 'string' || status.credentials.length < 20 || status.credentials.length > AUTH_MAX_BYTES / 2 || /[\s\x00-\x1f\x7f]/u.test(status.credentials)) throw authFailure();
          // The CLI's --no-refresh check proves configuration, not token validity.
          // Reject an expired JWT locally without exposing its payload or changing auth state.
          const parts = status.credentials.split('.');
          if (parts.length === 3) {
            let payload: unknown;
            try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw authFailure(); }
            const expires = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).exp : undefined;
            if (expires !== undefined && (typeof expires !== 'number' || !Number.isFinite(expires) || expires * 1000 <= Date.now() + 30_000)) throw authFailure();
          }
        }
        resolve(status as AuthStatus);
      } catch { reject(authFailure()); }
    });
  });
}

export function createCodexProvider(piCliPath = process.env.PI_CLI_PATH): Provider<'openai-codex-responses'> {
  if (!piCliPath || !isAbsolute(piCliPath) || !['.js', '.mjs', '.cjs'].includes(extname(piCliPath).toLowerCase())) {
    throw new Error('Configure provider.piCliPath or PI_CLI_PATH with the absolute installed Pi CLI JavaScript entry path.');
  }
  const provider = openaiCodexProvider();
  return {
    ...provider,
    streamSimple(model, context, options) {
      // Pi AI 1.5 Codex does not serialize maxTokens; retain host job budgets.
      return provider.streamSimple(model, context, {
        ...options, maxTokens: Math.min(options?.maxTokens ?? 4096,4096),
        timeoutMs: Math.min(options?.timeoutMs ?? 120_000,120_000), maxRetries: 0,
      });
    },
    auth: {
      apiKey: {
        name: 'Existing Pi Codex OAuth account (read only)',
        async check({ signal }): Promise<AuthCheck | undefined> {
          await readOnlyAuth(piCliPath, false, signal);
          return { source: 'Pi CLI OAuth (read only)', type: 'oauth' };
        },
        async resolve({ signal }): Promise<AuthResult | undefined> {
          const result = await readOnlyAuth(piCliPath, true, signal);
          return { auth: { apiKey: result.credentials! }, source: 'Pi CLI OAuth (read only)' };
        },
      },
    },
  };
}
