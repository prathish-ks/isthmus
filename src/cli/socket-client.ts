/**
 * SocketTransport — client side. Used by the `ncl` binary when running on
 * the host (i.e. invoked from a shell or by Claude in the project).
 *
 * Wire format: line-delimited JSON. One request per connection; the server
 * writes one response and closes.
 */
import net from 'net';
import path from 'path';

import { readEnvFile } from '../env.js';
import { getRuntimeSocketDir } from '../install-slug.js';
import type { RequestFrame, ResponseFrame } from './frame.js';
import type { Transport } from './transport.js';

// Deliberately NOT DATA_DIR-relative — see getRuntimeSocketDir's doc
// comment (src/install-slug.ts): a Unix socket path is capped at 104
// bytes on macOS/BSD, and DATA_DIR can be arbitrarily deep depending on
// where the user cloned the repo. Same short runtime dir as
// config.ts's KERNEL_SOCKET_PATH, distinct filename so the two socket
// servers never collide. Override via NANOCLAW_NCL_SOCKET — checked in
// both process.env and .env, matching KERNEL_SOCKET_PATH's own
// NANOCLAW_KERNEL_SOCKET override exactly, so the two parallel overrides
// don't silently behave differently for someone who reasonably expects
// them to.
const envConfig = readEnvFile(['NANOCLAW_NCL_SOCKET']);
export const DEFAULT_SOCKET_PATH =
  process.env.NANOCLAW_NCL_SOCKET || envConfig.NANOCLAW_NCL_SOCKET || path.join(getRuntimeSocketDir(), 'ncl.sock');

export class SocketTransport implements Transport {
  constructor(private readonly socketPath: string = DEFAULT_SOCKET_PATH) {}

  async sendFrame(req: RequestFrame): Promise<ResponseFrame> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(this.socketPath);
      let buffer = '';
      let settled = false;

      const settle = (action: 'resolve' | 'reject', valueOrErr: ResponseFrame | Error): void => {
        if (settled) return;
        settled = true;
        try {
          client.end();
        } catch (_e) {
          // best-effort
        }
        if (action === 'resolve') resolve(valueOrErr as ResponseFrame);
        else reject(valueOrErr as Error);
      };

      client.on('connect', () => {
        client.write(JSON.stringify(req) + '\n');
      });

      client.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const idx = buffer.indexOf('\n');
        if (idx < 0) return;
        const line = buffer.slice(0, idx);
        try {
          const frame = JSON.parse(line) as ResponseFrame;
          settle('resolve', frame);
        } catch (e) {
          settle('reject', new Error(`malformed response from host: ${e instanceof Error ? e.message : String(e)}`));
        }
      });

      client.on('error', (err) => settle('reject', err));
      client.on('close', () => {
        if (!settled) {
          settle('reject', new Error('host closed connection before sending response'));
        }
      });
    });
  }
}
