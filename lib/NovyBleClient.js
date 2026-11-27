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
    this._cleanup();
    this.log('BLE: searching', this.peripheralUuid);
    const advertisement = this.advertisement || await this.homey.ble.find(this.peripheralUuid);
    this.advertisement = null; // use a passed-in advertisement only once
    this.log('BLE: connecting to', advertisement.localName || advertisement.address || this.peripheralUuid);
    const peripheral = await advertisement.connect();
    this._peripheral = peripheral;

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
      await peripheral.disconnect().catch(() => {});
      this._cleanup();
      throw err;
    }

    // small settle delay before the first write
    await sleep(500);
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
    if (this._tx) await this._tx.unsubscribeFromNotifications().catch(() => {});
    this._cleanup();
    if (peripheral) await peripheral.disconnect().catch(() => {});
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
    this.log('BLE: disconnected');
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
    this._rx = null;
    this._tx = null;
  }

}

module.exports = NovyBleClient;
