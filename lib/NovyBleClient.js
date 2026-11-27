'use strict';

const { EventEmitter } = require('events');
const {
  NUS_SERVICE_UUID,
  NUS_RX_CHAR_UUID,
  NUS_TX_CHAR_UUID,
  STATUS_CMDS,
  PARSERS,
  buildFrame,
  isAck,
} = require('./NovyProtocol');

const RESPONSE_TIMEOUT_MS = 8000;
const WRITE_GAP_MS = 200; // the hood drops the link when frames arrive too fast

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timeout`)), ms); }),
  ]);
}

/**
 * One BLE connection to one Novy hood.
 *
 * Events:
 *   'state'      (partial state object)  every parsed status packet
 *   'disconnect'                         link lost
 */
class NovyBleClient extends EventEmitter {

  constructor({ homey, peripheralUuid, log = () => {} }) {
    super();
    this.homey = homey;
    this.peripheralUuid = peripheralUuid;
    this.log = log;

    this._peripheral = null;
    this._lastPeripheral = null; // kept so a lingering link can always be released / reused
    this._connectedAt = 0;
    this._rx = null;
    this._tx = null;
    this._connecting = null;
    this._queue = Promise.resolve();
    this._pending = null; // { cmd, resolve, reject, timer }
  }

  get isConnected() {
    return !!(this._peripheral && this._peripheral.isConnected && this._rx);
  }

  async connect() {
    if (this.isConnected) return;
    if (this._connecting) return this._connecting;
    this._connecting = this._doConnect().finally(() => {
      this._connecting = null;
    });
    return this._connecting;
  }

  async _doConnect() {
    // Never drop a peripheral object without disconnecting it: an orphaned link keeps the hood
    // connected to Homey, and a connected hood stops advertising ("Peripheral Not Found").
    const old = this._peripheral;
    this._cleanup();
    if (old) await this._release(old, 'previous link');

    let peripheral;
    try {
      this.log('BLE: searching', this.peripheralUuid);
      const advertisement = this.advertisement || await this.homey.ble.find(this.peripheralUuid);
      this.advertisement = null; // use a passed-in advertisement only once
      if (typeof advertisement.rssi === 'number') this.emit('rssi', advertisement.rssi);
      this.log('BLE: connecting to', advertisement.localName || advertisement.address || this.peripheralUuid,
        advertisement.rssi !== undefined ? `(rssi ${advertisement.rssi})` : '');
      peripheral = await withTimeout(advertisement.connect(), 40000, 'connect');
    } catch (err) {
      const last = this._lastPeripheral;
      if (!last || typeof last.connect !== 'function') throw err;
      // The hood is not advertising: most likely it still holds an old link to Homey.
      this.log(`BLE: ${err.message} – releasing the previous link and reconnecting directly`);
      await this._release(last, 'stale link');
      peripheral = await withTimeout(last.connect(), 40000, 'reconnect');
    }
    this._peripheral = peripheral;
    this._lastPeripheral = peripheral;

    if (typeof peripheral.once === 'function') {
      peripheral.once('disconnect', () => this._onDisconnect());
    }

    try {
      await peripheral.discoverAllServicesAndCharacteristics();
      const service = await peripheral.getService(NUS_SERVICE_UUID);
      const rx = await service.getCharacteristic(NUS_RX_CHAR_UUID);
      const tx = await service.getCharacteristic(NUS_TX_CHAR_UUID);
      await tx.subscribeToNotifications(data => this._onNotification(data));
      // The official Novy app reads the RX characteristic once after connecting.
      try { await rx.read(); } catch (err) { /* not readable on every firmware */ }
      this._rx = rx;
      this._tx = tx;
    } catch (err) {
      await this._release(peripheral, 'failed setup');
      this._cleanup();
      throw err;
    }

    // small settle delay before the first write
    await sleep(500);
    this._connectedAt = Date.now();
    this.log('BLE: connected');
  }

  /** Human-readable list of GATT services/characteristics, for pairing diagnostics. */
  describeGatt() {
    const services = (this._peripheral && this._peripheral.services) || [];
    const lines = [];
    for (const service of services) {
      lines.push(`service ${service.uuid}`);
      for (const ch of service.characteristics || []) {
        const props = Array.isArray(ch.properties) ? ch.properties.join(',') : '';
        lines.push(`  char ${ch.uuid}${props ? ` [${props}]` : ''}`);
      }
    }
    return lines;
  }

  async disconnect() {
    const peripheral = this._peripheral;
    const tx = this._tx;
    this._cleanup();
    if (tx) await withTimeout(tx.unsubscribeFromNotifications(), 3000, 'unsubscribe').catch(() => {});
    if (peripheral) await this._release(peripheral, 'disconnect');
  }

  async _release(peripheral, why) {
    try {
      await withTimeout(peripheral.disconnect(), 5000, 'disconnect');
    } catch (err) {
      this.log(`BLE: releasing ${why} failed: ${err.message}`);
    }
  }

  /**
   * Queue a command; resolves with the hood's reply:
   *   { type: 'ack', raw: '1;1;1' }
   *   { type: 'status', cmd, state }
   *   { type: 'unknown', raw: '<hex>' }
   */
  send(cmd, ...args) {
    return this.sendTimed(RESPONSE_TIMEOUT_MS, cmd, ...args);
  }

  /** Like send(), with a custom reply timeout (used for optional getters). */
  sendTimed(timeoutMs, cmd, ...args) {
    const job = this._queue.then(() => this._send(cmd, args, timeoutMs));
    // keep the queue alive after errors
    this._queue = job.catch(() => {});
    return job;
  }

  async _send(cmd, args, timeoutMs = RESPONSE_TIMEOUT_MS) {
    if (!this.isConnected) throw new Error('Not connected');
    const frame = buildFrame(cmd, ...args);

    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending = null;
        reject(new Error(`No reply to ${frame}`));
      }, timeoutMs);
      this._pending = { cmd, resolve, reject, timer };
    });
    // avoid unhandled rejection if write fails first
    reply.catch(() => {});

    this.log('TX', frame);
    try {
      await this._rx.write(Buffer.from(frame, 'ascii'));
    } catch (err) {
      this._clearPending(err);
      throw err;
    }

    try {
      return await reply;
    } finally {
      await sleep(WRITE_GAP_MS);
    }
  }

  _onNotification(data) {
    const buf = Buffer.from(data);
    const pending = this._pending;
    if (!pending) {
      this.log('RX (unsolicited)', buf.toString('hex'));
      this.emit('unsolicited', buf);
      return;
    }
    this._pending = null;
    clearTimeout(pending.timer);

    if (isAck(buf)) {
      const raw = buf.slice(1, -1).toString('ascii');
      this.log('ACK', raw);
      pending.resolve({ type: 'ack', raw });
      return;
    }

    if (STATUS_CMDS.includes(pending.cmd)) {
      try {
        const state = PARSERS[pending.cmd](buf);
        this.emit('state', state);
        pending.resolve({ type: 'status', cmd: pending.cmd, state });
      } catch (err) {
        this.log('Parse error', err.message, buf.toString('hex'));
        pending.resolve({ type: 'unknown', raw: buf.toString('hex') });
      }
      return;
    }

    this.log('RX (unknown)', buf.toString('hex'));
    pending.resolve({ type: 'unknown', raw: buf.toString('hex') });
  }

  _onDisconnect() {
    if (!this._peripheral) return;
    const secs = this._connectedAt ? Math.round((Date.now() - this._connectedAt) / 1000) : 0;
    this.log(`BLE: disconnected by the hood or Homey after ${secs}s`);
    this._cleanup();
    this.emit('disconnect');
  }

  _clearPending(err) {
    if (!this._pending) return;
    clearTimeout(this._pending.timer);
    this._pending.reject(err);
    this._pending = null;
  }

  _cleanup() {
    this._clearPending(new Error('Disconnected'));
    this._peripheral = null;
    this._connectedAt = 0;
    this._rx = null;
    this._tx = null;
  }

}

module.exports = NovyBleClient;
