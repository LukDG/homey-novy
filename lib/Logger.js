'use strict';

const MAX_BYTES = 256 * 1024; // cap of the in-memory log

/**
 * In-memory log, capped at 256 KB (oldest lines are dropped first). Nothing is written to the
 * Homey's flash storage, so the log starts empty after every app or Homey restart.
 */
class Logger {
  constructor({ timezone = 'UTC' } = {}) {
    this.timezone = timezone;
    this.enabled = true;
    this.lines = [];
    this.bytes = 0;
    this.dropped = 0;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
  }

  _stamp() {
    try {
      return new Date().toLocaleString('sv-SE', { timeZone: this.timezone }); // 2026-11-24 21:54:01
    } catch (e) {
      return new Date().toISOString();
    }
  }

  static _text(args) {
    return args.map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch (e) {
        return String(a);
      }
    }).join(' ');
  }

  write(level, ...args) {
    if (!this.enabled) return;
    let text = Logger._text(args).replace(/\r/g, '');
    if (text.length > 4000) text = `${text.slice(0, 4000)} …`;
    const line = `${this._stamp()} ${level.padEnd(5)} ${text}\n`;
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line);
    while (this.bytes > MAX_BYTES && this.lines.length > 1) {
      this.bytes -= Buffer.byteLength(this.lines.shift());
      this.dropped += 1;
    }
  }

  read() {
    const head = this.dropped ? `--- ${this.dropped} oudere regels verwijderd (max. 256 KB) ---\n` : '';
    return { enabled: this.enabled, size: this.bytes, max: MAX_BYTES, text: head + this.lines.join('') };
  }

  clear() {
    this.lines = [];
    this.bytes = 0;
    this.dropped = 0;
    this.write('INFO', 'Logboek gewist');
  }

  /**
   * Mirror everything the app prints (this.log / this.error of app, drivers and devices, and the
   * STIGA library) into the log. The normal console output stays unchanged.
   */
  captureConsole() {
    if (this._captured) return;
    this._captured = true;
    const map = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR' };
    for (const [method, level] of Object.entries(map)) {
      const original = console[method].bind(console);
      console[method] = (...args) => {
        original(...args);
        try {
          this.write(level, ...args);
        } catch (e) { /* logging must never break the app */ }
      };
    }
  }
}

Logger.MAX_BYTES = MAX_BYTES;
module.exports = Logger;
