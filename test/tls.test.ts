import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import rxpress, { type ServerHandle } from '../js/index.js';

let activeServers: ServerHandle[] = [];
let tempDirs: string[] = [];

function generateSelfSignedCert(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'rxpress-tls-'));
  tempDirs.push(dir);
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=127.0.0.1"`,
    { stdio: 'ignore' }
  );
  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}

function httpsGetJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  for (const srv of activeServers) {
    await srv.close();
  }
  activeServers = [];
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('HTTPS / TLS Support (rustls)', () => {
  it('serves HTTPS via app.listenTls() and reports req.secure === true', async () => {
    const { key, cert } = generateSelfSignedCert();
    const app = rxpress();
    app.get('/tls-check', (req, res) => {
      res.json({
        protocol: req.protocol,
        secure: req.secure,
        encrypted: req.socket.encrypted,
      });
    });

    const srv = app.listenTls({ key, cert }, 0, '127.0.0.1');
    activeServers.push(srv);
    const port = srv.address()!.port;

    const result = await httpsGetJson(port, '/tls-check');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      protocol: 'https',
      secure: true,
      encrypted: true,
    });
  });

  it('serves HTTPS via express.createHttpsServer({ key, cert }, app)', async () => {
    const { key, cert } = generateSelfSignedCert();
    const app = rxpress();
    app.get('/hello', (_req, res) => res.json({ tls: 'ok' }));

    const srv = rxpress.createHttpsServer({ key, cert }, app).listen(0, '127.0.0.1');
    activeServers.push(srv);
    const port = srv.address()!.port;

    const result = await httpsGetJson(port, '/hello');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ tls: 'ok' });
  });
});
