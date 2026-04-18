// Supervises the MediaMTX process. Spawns on startup, restarts on crash,
// stops cleanly on SIGINT/SIGTERM. Streams stdout/stderr with a prefix.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export class MediaMTX {
  constructor({ binary, config }) {
    this.binary = resolve(binary);
    this.config = resolve(config);
    this.proc = null;
    this.stopping = false;
    this.restartDelayMs = 1000;
  }

  start() {
    if (!existsSync(this.binary)) {
      console.error(`[mediamtx] binary not found at ${this.binary}`);
      console.error('[mediamtx] Download from https://github.com/bluenviron/mediamtx/releases');
      console.error('[mediamtx] and set MEDIAMTX_PATH in .env');
      return false;
    }
    if (!existsSync(this.config)) {
      console.error(`[mediamtx] config not found at ${this.config}`);
      return false;
    }
    console.log(`[mediamtx] starting ${this.binary}`);
    this.proc = spawn(this.binary, [this.config], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => process.stdout.write(`[mediamtx] ${d}`));
    this.proc.stderr.on('data', (d) => process.stderr.write(`[mediamtx] ${d}`));
    this.proc.on('exit', (code, signal) => {
      console.log(`[mediamtx] exited code=${code} signal=${signal}`);
      this.proc = null;
      if (!this.stopping) {
        setTimeout(() => this.start(), this.restartDelayMs);
      }
    });
    return true;
  }

  stop() {
    this.stopping = true;
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
    }
  }
}
