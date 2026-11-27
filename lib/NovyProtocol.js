'use strict';

/**
 * Novy BLE protocol (Pureline Pro / Cloud / newer Bluetooth hoods).
 *
 * Transport: Nordic UART Service (NUS).
 *   - write ASCII frames like "[28;1;75]" to the RX characteristic
 *   - the hood answers on the TX characteristic (notify) with either an ASCII
 *     ACK "[1;1;1]" or a binary status packet (16 or 20 bytes)
 *
 * Protocol knowledge based on the reverse-engineering in
 * https://github.com/bwynants/hass-purelinepro (MIT licence).
 */

// Homey uses lower-case UUIDs without dashes.
const NUS_SERVICE_UUID = '6e400001b5a3f393e0a9e50e24dcca9e';
const NUS_RX_CHAR_UUID = '6e400002b5a3f393e0a9e50e24dcca9e'; // write: Homey -> hood
const NUS_TX_CHAR_UUID = '6e400003b5a3f393e0a9e50e24dcca9e'; // notify: hood -> Homey

// Service UUIDs the hood/hob/lighting advertise (from the official Novy app)
const NOVY_HOOD_ADV_UUID = '8ec90001f3154f609fb8838830daea50';
const NOVY_HOB_ADV_UUID = 'bdc6935447d54e4ca50ce1b35cd8eece';
const NOVY_LIGHTING_ADV_UUID = '01944130f65e7f74940e2d27ddb87bf6';

const CMD = Object.freeze({
  POWER: 10, // same as the power button on the remote (on / off with run-on)
  LIGHT_ON_AMBI: 15,
  LIGHT_ON_WHITE: 16,
  LIGHT_BRIGHTNESS: 21, // [21;1;0-255]
  LIGHT_COLORTEMP: 22, // [22;1;0-255] 0 = cool 6500K, 255 = warm 2700K
  RESET_GREASE: 23,
  RESET_CARBON: 24,
  FAN_RECIRCULATE: 25, // [25;1;0|1]
  AUTOMODE: 26, // [26;1;0|1]
  FAN_SPEED: 28, // [28;1;0-100]
  FAN_STATE: 29, // [29;1;0|1]
  LIGHT_OFF: 36,
  HOOD_ON: 38,
  HOOD_OFF: 39,
  ECO: 40,
  FAN_DEFAULT: 41, // store current speed as default/switch-off speed
  LIGHT_DEFAULT: 42, // [42;1;mode]
  KEYLOCK: 54, // [54;1;0|1]
  // getters, reply "[1;1;value]"
  GET_TEMPERATURE: 104,
  GET_HUMIDITY: 105,
  GET_CO2: 106,
  GET_RUNNING_TIME: 109,
  IS_AUTOMODE: 116,
  IS_CARBON_AVAILABLE: 127,
  GET_CARBON_REMAINING: 129,
  GET_KEYLOCK: 140,
  GET_SERIAL: 206,
  GET_PRODUCT_TYPE: 207,
  OEM_ID: 213,
  CODE_ON_LEDS: 300, // pairing: hood waits for confirmation on the remote
  CHECK_CODE: 301, // pairing: [301;1;0] -> ACK "1" once the user confirmed
  STATUS: 400,
  STATUS_402: 402,
  STATUS_403: 403,
  STATUS_404: 404,
});

const STATUS_CMDS = [CMD.STATUS, CMD.STATUS_402, CMD.STATUS_403, CMD.STATUS_404];

function normalizeUuid(uuid) {
  return String(uuid || '').toLowerCase().replace(/-/g, '');
}

function buildFrame(cmd, ...args) {
  const parts = [cmd, ...args].map(v => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`Invalid command value: ${v}`);
    return String(n);
  });
  return `[${parts.join(';')}]`;
}

/** Parse "28;1;50" or "[28;1;50]" into [28, 1, 50]. */
function parseRawCommand(text) {
  const clean = String(text || '').trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!clean) throw new Error('Empty command');
  const values = clean.split(/[;,\s]+/).filter(Boolean).map(Number);
  if (values.some(v => !Number.isInteger(v) || v < 0)) {
    throw new Error(`Invalid command: ${text}`);
  }
  return values;
}

/** Fields of an ASCII reply "[1;0]" -> ['1', '0']. */
function ackFields(raw) {
  return String(raw || '').replace(/^\[/, '').replace(/\]$/, '').split(';');
}

/**
 * Getter reply "[1;1;value]" (field 0 = "1" means OK, value in the last field).
 * Returns null when the hood answered NACK or with an unexpected format.
 */
function parseGetter(reply) {
  if (!reply || reply.type !== 'ack') return null;
  const fields = ackFields(reply.raw);
  if (fields.length < 3 || fields[0] !== '1') return null;
  const value = Number.parseInt(fields[fields.length - 1], 10);
  return Number.isNaN(value) ? null : value;
}

function isAck(buf) {
  return buf.length >= 2 && buf[0] === 0x5b && buf[buf.length - 1] === 0x5d; // '[' ... ']'
}

/** Main status, 16 bytes. */
function parse400(buf) {
  if (buf.length !== 16) throw new Error(`Packet400: expected 16 bytes, got ${buf.length}`);
  const flags1 = buf[0];
  const fanSpeed = buf[1];
  const flags2 = buf[2];
  const lightMode = buf[5];
  const brightness = buf[6];
  const colorTemp = buf[7];
  const timerActive = (flags1 & 0x02) !== 0;
  const boost = timerActive && fanSpeed > 75;
  const stopping = timerActive && !boost;
  return {
    fanOn: fanSpeed > 0,
    fanSpeed, // 0-100 %
    motorEnergised: (flags1 & 0x01) !== 0,
    lightOn: brightness > 0,
    lightMode, // 0 off, 1 white, 2 ambi
    brightness, // 0-255
    colorTemp, // 0-255
    boost,
    stopping,
    timerSeconds: timerActive ? buf.readUInt16BE(8) : 0,
    greaseDirty: (flags2 & 0x01) !== 0,
  };
}

/** Recirculation, grease timer, firmware, 20 bytes. */
function parse402(buf) {
  if (buf.length !== 20) throw new Error(`Packet402: expected 20 bytes, got ${buf.length}`);
  return {
    recirculate: (buf[2] & 0x01) !== 0,
    greaseMinutes: Math.floor(buf.readUInt32BE(4) / 60),
    firmware: `${buf[8]}.${buf[9]}.${buf[10]}`,
  };
}

/** Default speeds and fan operating time, 20 bytes. */
function parse403(buf) {
  if (buf.length < 20) throw new Error(`Packet403: need 20 bytes, got ${buf.length}`);
  return {
    switchOffFanSpeed: buf[0],
    fanOperatingMinutes: Math.floor(buf.readUInt32BE(10) / 60),
  };
}

/** LED operating time, 20 bytes. */
function parse404(buf) {
  if (buf.length < 20) throw new Error(`Packet404: need 20 bytes, got ${buf.length}`);
  return {
    ledOperatingMinutes: Math.floor(buf.readUInt32BE(13) / 60),
  };
}

const PARSERS = {
  [CMD.STATUS]: parse400,
  [CMD.STATUS_402]: parse402,
  [CMD.STATUS_403]: parse403,
  [CMD.STATUS_404]: parse404,
};

module.exports = {
  NUS_SERVICE_UUID,
  NUS_RX_CHAR_UUID,
  NUS_TX_CHAR_UUID,
  NOVY_HOOD_ADV_UUID,
  NOVY_HOB_ADV_UUID,
  NOVY_LIGHTING_ADV_UUID,
  CMD,
  STATUS_CMDS,
  PARSERS,
  normalizeUuid,
  buildFrame,
  parseRawCommand,
  isAck,
  ackFields,
  parseGetter,
  parse400,
  parse402,
  parse403,
  parse404,
};
