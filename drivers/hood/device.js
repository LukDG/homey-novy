'use strict';

const Homey = require('homey');
const NovyBleClient = require('../../lib/NovyBleClient');
const { CMD, parseRawCommand, parseGetter } = require('../../lib/NovyProtocol');

const EXTENDED_EVERY = 10; // every Nth poll also read 402/403/404
const FAILS_BEFORE_UNAVAILABLE = 3;
const DEFAULT_SWITCH_OFF_SPEED = 25;

// Optional features, only added when the hood answers the matching getter.
const LANGS = ['en', 'nl', 'de', 'fr', 'it', 'sv', 'no', 'es', 'da', 'ru', 'pl', 'ko', 'ar'];
const LOCALES = Object.fromEntries(LANGS.map(l => [l, require(`../../locales/${l}.json`)]));
const titleOf = key => Object.fromEntries(LANGS.map(l => [l, LOCALES[l].feature[key]]));
const FEATURES = {
  automode: { cap: 'onoff.automode', title: titleOf('automode') },
  keylock: { cap: 'onoff.keylock', title: titleOf('keylock') },
  carbon: { cap: 'alarm_generic.carbon', title: titleOf('carbon') },
  temperature: { cap: 'measure_temperature' },
  humidity: { cap: 'measure_humidity' },
  co2: { cap: 'measure_co2' },
};

class NovyHoodDevice extends Homey.Device {

  async onInit() {
    this._pollCount = 0;
    this._failCount = 0;
    this._pollTimer = null;
    this._delayedOff = null; // { timer, speed }
    this._switchOffSpeed = DEFAULT_SWITCH_OFF_SPEED;
    this._deleted = false;
    this._probed = false;
    this._listenersAdded = new Set();
    this._light = { on: false, brightness: 0, colorTemp: 0, mode: 0 };
    this._available = true;

    await this._migrateCapabilities();

    this._paused = false;
    this._createClient();

    this.registerCapabilityListener('onoff', value => this.setFan(value));
    this.registerCapabilityListener('dim', value => this.setFanSpeed(Math.round(value * 100)));
    this.registerCapabilityListener('onoff.recirculate', value => this.setRecirculate(value));

    for (const feature of Object.values(FEATURES)) {
      if (this.hasCapability(feature.cap)) this._registerFeatureListener(feature.cap);
    }

    this._schedulePoll(2000);
    this.log('Novy hood initialised', this.getName());
  }

  _peripheralUuid() {
    return this.getStoreValue('peripheralUuid') || this.getData().id;
  }

  _createClient() {
    if (this.client) this.client.removeAllListeners();
    this.client = new NovyBleClient({
      homey: this.homey,
      peripheralUuid: this._peripheralUuid(),
      log: (...args) => this.log(...args),
    });
    this.client.on('state', state => this._applyState(state).catch(this.error));
    this.client.on('disconnect', () => this._schedulePoll(1000));
    this.client.on('rssi', rssi => this._setInfo({ signal: this._signalText(rssi) }).catch(this.error));
  }

  // ---------------------------------------------------------------- repair

  async pauseForRepair() {
    this._paused = true;
    if (this._pollTimer) this.homey.clearTimeout(this._pollTimer);
    this._pollTimer = null;
    await this.client.disconnect().catch(() => {});
    this.log('Repair: polling paused, Bluetooth link released');
  }

  async applyRepair(adv, firmware) {
    await this.setStoreValue('peripheralUuid', adv.uuid);
    await this.setStoreValue('address', adv.address || '');
    await this._setInfo({ ble_address: adv.address || '-', ble_name: adv.localName || '-', firmware: firmware || '-' });
    if (typeof adv.rssi === 'number') await this._setInfo({ signal: this._signalText(adv.rssi) });
  }

  async resumeAfterRepair() {
    if (!this._paused) return;
    this._paused = false;
    this._failCount = 0;
    this._createClient(); // fresh client, possibly with the newly found Bluetooth id
    this.log('Repair finished, reconnecting to', this._peripheralUuid());
    this._schedulePoll(500);
  }

  async _migrateCapabilities() {
    const wanted = ['onoff', 'dim', 'onoff.recirculate', 'novy_status', 'novy_timer', 'alarm_generic', 'novy_grease_hours'];
    for (const cap of wanted) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }
    // 2026.1127.1: the light moved to its own device (driver "light")
    for (const cap of ['onoff.light', 'dim.light', 'light_temperature']) {
      if (this.hasCapability(cap)) await this.removeCapability(cap).catch(this.error);
    }
  }

  // ---------------------------------------------------------------- light device (same hood)

  _lightDevice() {
    try {
      const id = this.getData().id;
      return this.homey.drivers.getDriver('light').getDevices().find(d => d.getData().id === id) || null;
    } catch (err) {
      return null; // light driver not ready yet
    }
  }

  getLightState() {
    return { ...this._light };
  }

  isHoodAvailable() {
    return this._available;
  }

  async _setReachable(ok) {
    if (this._available === ok) return;
    this._available = ok;
    const reason = this.homey.__('error.unreachable');
    await (ok ? this.setAvailable() : this.setUnavailable(reason)).catch(this.error);
    const light = this._lightDevice();
    if (light) await light.syncFromHood(this).catch(this.error);
  }

  // ---------------------------------------------------------------- polling

  _schedulePoll(delayMs) {
    if (this._deleted || this._paused) return;
    if (this._pollTimer) this.homey.clearTimeout(this._pollTimer);
    const interval = Math.max(2, Number(this.getSetting('poll_interval')) || 5) * 1000;
    this._pollTimer = this.homey.setTimeout(() => this._poll(), delayMs ?? interval);
  }

  async _poll() {
    this._pollTimer = null;
    if (this._paused) return;
    const keepConnected = this.getSetting('keep_connected') !== false;
    try {
      await this.client.connect();
      if (this._paused) { await this.client.disconnect().catch(() => {}); return; }
      const extended = !keepConnected || this._pollCount % EXTENDED_EVERY === 0;
      // the first frame right after connecting is sometimes lost: retry once
      await this.client.send(CMD.STATUS, 0).catch(err => {
        this.log('Status retry:', err.message);
        return this.client.send(CMD.STATUS, 0);
      });
      if (extended) {
        for (const cmd of [CMD.STATUS_402, CMD.STATUS_403, CMD.STATUS_404]) {
          await this.client.send(cmd, 0).catch(err => this.log(`Status ${cmd}:`, err.message));
        }
      }
      if (!this._probed) {
        this._probed = true;
        await this._probeFeatures().catch(err => this.log('Feature probe failed:', err.message));
      } else if (extended) {
        await this._pollExtras().catch(err => this.log('Extras poll:', err.message));
      }
      this._pollCount++;
      this._failCount = 0;
      await this._setReachable(true);
    } catch (err) {
      this._failCount++;
      this.log(`Poll failed (${this._failCount}):`, err.message);
      if (/not found/i.test(err.message)) await this._setInfo({ signal: this.homey.__('signal.none') });
      if (this._failCount >= FAILS_BEFORE_UNAVAILABLE) await this._setReachable(false);
      await this.client.disconnect().catch(() => {});
    } finally {
      if (!keepConnected && this.client.isConnected) {
        await this.client.disconnect().catch(() => {});
      }
    }
    const backoff = this._failCount ? Math.min(60000, 5000 * this._failCount) : undefined;
    this._schedulePoll(backoff);
  }

  /** Connect if needed, send commands, refresh status. */
  async _command(commands, refreshCmd = CMD.STATUS) {
    if (this._paused) throw new Error(this.homey.__('error.repairing'));
    try {
      await this.client.connect();
      for (const [cmd, ...args] of commands) {
        await this.client.send(cmd, ...args);
      }
    } catch (err) {
      this.error(`Commando mislukt (${commands.map(c => `[${c.join(';')}]`).join(' ')}):`, err.message);
      throw err;
    }
    if (refreshCmd) await this.client.send(refreshCmd, 0).catch(this.error);
    if (this.getSetting('keep_connected') === false) {
      await this.client.disconnect().catch(() => {});
    }
  }

  // ---------------------------------------------------------------- optional features

  async _query(cmd) {
    return parseGetter(await this.client.sendTimed(3000, cmd, 0).catch(() => null));
  }

  async _probeFeatures() {
    const found = [];
    const has = async (name, test) => {
      if (test) {
        found.push(name);
        await this._enableFeature(name);
      }
    };
    const automode = await this._query(CMD.IS_AUTOMODE);
    await has('automode', automode !== null);
    const keylock = await this._query(CMD.GET_KEYLOCK);
    await has('keylock', keylock !== null);
    const carbon = await this._query(CMD.IS_CARBON_AVAILABLE);
    await has('carbon', carbon === 1);
    const temperature = await this._query(CMD.GET_TEMPERATURE);
    await has('temperature', temperature !== null && temperature > -30 && temperature < 90 && temperature !== 0);
    const humidity = await this._query(CMD.GET_HUMIDITY);
    await has('humidity', humidity !== null && humidity > 0);
    const co2 = await this._query(CMD.GET_CO2);
    await has('co2', co2 !== null && co2 > 0);

    const serial = await this._query(CMD.GET_SERIAL);
    const productType = await this._query(CMD.GET_PRODUCT_TYPE);
    await this._setInfo({
      serial: serial !== null ? String(serial) : '-',
      product_type: productType !== null ? String(productType) : '-',
      features: found.length ? found.join(', ') : '-',
    });
    this.log('Features:', found.join(', ') || 'none',
      JSON.stringify({ automode, keylock, carbon, temperature, humidity, co2, serial, productType }));
    await this._pollExtras();
  }

  async _enableFeature(name) {
    const { cap, title } = FEATURES[name];
    if (!this.hasCapability(cap)) {
      await this.addCapability(cap);
      if (title) await this.setCapabilityOptions(cap, { title }).catch(this.error);
    }
    this._registerFeatureListener(cap);
  }

  _registerFeatureListener(cap) {
    if (this._listenersAdded.has(cap)) return;
    if (cap === 'onoff.automode') this.registerCapabilityListener(cap, value => this.setAutomode(value));
    else if (cap === 'onoff.keylock') this.registerCapabilityListener(cap, value => this.setKeylock(value));
    else return;
    this._listenersAdded.add(cap);
  }

  async _pollExtras() {
    const set = (cap, value) => {
      if (value === null || value === undefined || !this.hasCapability(cap)) return null;
      if (this.getCapabilityValue(cap) === value) return null;
      return this.setCapabilityValue(cap, value).catch(this.error);
    };
    if (this.hasCapability('onoff.automode')) {
      const v = await this._query(CMD.IS_AUTOMODE);
      if (v !== null) await set('onoff.automode', v === 1);
    }
    if (this.hasCapability('onoff.keylock')) {
      const v = await this._query(CMD.GET_KEYLOCK);
      if (v !== null) await set('onoff.keylock', v === 1);
    }
    if (this.hasCapability('alarm_generic.carbon')) {
      const v = await this._query(CMD.GET_CARBON_REMAINING);
      if (v !== null) {
        const dirty = v <= 0;
        if (dirty && this.getCapabilityValue('alarm_generic.carbon') === false) {
          this.driver.triggerCarbonDirty.trigger(this).catch(this.error);
        }
        await set('alarm_generic.carbon', dirty);
        await this._setInfo({ carbon_remaining: String(v) });
      }
    }
    if (this.hasCapability('measure_temperature')) await set('measure_temperature', await this._query(CMD.GET_TEMPERATURE));
    if (this.hasCapability('measure_humidity')) {
      const v = await this._query(CMD.GET_HUMIDITY);
      if (v !== null) await set('measure_humidity', v / 10); // hood reports tenths of %
    }
    if (this.hasCapability('measure_co2')) await set('measure_co2', await this._query(CMD.GET_CO2));
  }

  async setAutomode(on) {
    await this._command([[CMD.AUTOMODE, 1, on ? 1 : 0]]);
    if (this.hasCapability('onoff.automode')) await this.setCapabilityValue('onoff.automode', !!on).catch(this.error);
  }

  async setKeylock(on) {
    await this._command([[CMD.KEYLOCK, 1, on ? 1 : 0]], null);
    if (this.hasCapability('onoff.keylock')) await this.setCapabilityValue('onoff.keylock', !!on).catch(this.error);
  }

  async resetCarbonFilter() {
    await this._command([[CMD.RESET_CARBON, 0]], null);
    await this._pollExtras().catch(this.error);
  }

  async redetectFeatures() {
    await this.client.connect();
    await this._probeFeatures();
  }

  // ---------------------------------------------------------------- state

  async _applyState(state) {
    const set = (cap, value) => {
      if (value === undefined || !this.hasCapability(cap)) return null;
      if (this.getCapabilityValue(cap) === value) return null;
      return this.setCapabilityValue(cap, value).catch(this.error);
    };
    const jobs = [];

    if ('fanSpeed' in state) {
      const previousStatus = this.getCapabilityValue('novy_status');
      const previousGrease = this.getCapabilityValue('alarm_generic');

      let status = 'off';
      if (state.fanOn) status = state.boost ? 'boost' : (state.stopping ? 'afterrun' : 'running');

      jobs.push(set('onoff', state.fanOn));
      jobs.push(set('dim', state.fanSpeed / 100));
      this._light = { on: state.lightOn, brightness: state.brightness, colorTemp: state.colorTemp, mode: state.lightMode };
      const light = this._lightDevice();
      if (light) jobs.push(light.syncFromHood(this).catch(this.error));
      jobs.push(set('alarm_generic', state.greaseDirty));
      jobs.push(set('novy_status', status));
      jobs.push(set('novy_timer', Math.ceil(state.timerSeconds / 60)));

      const driver = this.driver;
      if (previousStatus !== null && previousStatus !== status) {
        driver.triggerStatusChanged.trigger(this, { status: this.homey.__(`status.${status}`) }).catch(this.error);
      }
      if (previousGrease === false && state.greaseDirty) {
        driver.triggerGreaseDirty.trigger(this).catch(this.error);
      }

      this._checkDelayedOff(state);
    }

    if ('recirculate' in state) {
      jobs.push(set('onoff.recirculate', state.recirculate));
      jobs.push(set('novy_grease_hours', Math.round(state.greaseMinutes / 6) / 10));
      jobs.push(this._setInfo({ firmware: state.firmware }));
    }
    if ('switchOffFanSpeed' in state) {
      if (state.switchOffFanSpeed > 0) this._switchOffSpeed = state.switchOffFanSpeed;
      jobs.push(this._setInfo({ fan_hours: String(Math.round(state.fanOperatingMinutes / 60)) }));
    }
    if ('ledOperatingMinutes' in state) {
      jobs.push(this._setInfo({ led_hours: String(Math.round(state.ledOperatingMinutes / 60)) }));
    }

    await Promise.all(jobs);
  }

  _signalText(rssi) {
    const level = rssi >= -70 ? 'good' : rssi >= -80 ? 'fair' : rssi >= -88 ? 'weak' : 'too_weak';
    return `${rssi} dBm – ${this.homey.__(`signal.${level}`)}`;
  }

  async _setInfo(values) {
    const changed = {};
    for (const [key, value] of Object.entries(values)) {
      if (this.getSetting(key) !== value) changed[key] = value;
    }
    if (Object.keys(changed).length) await this.setSettings(changed).catch(this.error);
  }

  // ---------------------------------------------------------------- actions

  async setFan(on) {
    if (!on) this._cancelDelayedOff();
    await this._command([[CMD.FAN_STATE, 1, on ? 1 : 0]]);
  }

  async setFanSpeed(speed) {
    const pct = Math.max(0, Math.min(100, Math.round(Number(speed))));
    this._cancelDelayedOff();
    if (pct === 0) return this.setFan(false);
    const commands = [];
    if (!this.getCapabilityValue('onoff')) commands.push([CMD.FAN_STATE, 1, 1]);
    commands.push([CMD.FAN_SPEED, 1, pct]);
    return this._command(commands);
  }

  async startDelayedOff(minutes) {
    const mins = Math.max(1, Number(minutes) || (this.getCapabilityValue('onoff.recirculate') ? 30 : 5));
    const speed = this._switchOffSpeed || DEFAULT_SWITCH_OFF_SPEED;
    await this.setFanSpeed(speed); // cancels a running delayed-off first
    this._delayedOff = {
      speed,
      timer: this.homey.setTimeout(() => {
        this._delayedOff = null;
        this.setFan(false).catch(this.error);
      }, mins * 60 * 1000),
    };
    this.log(`Delayed off: ${speed}% for ${mins} min`);
  }

  _checkDelayedOff(state) {
    if (!this._delayedOff) return;
    // cancelled when someone raises the speed, the fan goes off, or the hood runs its own timer
    if (!state.fanOn || state.fanSpeed > this._delayedOff.speed || state.stopping) {
      this.log('Delayed off cancelled by hood state');
      this._cancelDelayedOff();
    }
  }

  _cancelDelayedOff() {
    if (!this._delayedOff) return;
    this.homey.clearTimeout(this._delayedOff.timer);
    this._delayedOff = null;
  }

  async lightOn(preset = 'white') {
    await this._command([[preset === 'ambi' ? CMD.LIGHT_ON_AMBI : CMD.LIGHT_ON_WHITE, 0]]);
  }

  async lightOff() {
    await this._command([[CMD.LIGHT_OFF, 0]]);
  }

  async setLightBrightness(fraction, preset = 'white') {
    const raw = Math.round(Math.max(0, Math.min(1, Number(fraction))) * 255);
    if (raw === 0) return this.lightOff();
    const mode = preset === 'ambi' ? CMD.LIGHT_ON_AMBI : CMD.LIGHT_ON_WHITE;
    const commands = [];
    if (!this._light.on) commands.push([mode, 0]);
    commands.push([CMD.LIGHT_BRIGHTNESS, 1, raw]);
    return this._command(commands);
  }

  async setLightTemperature(fraction) {
    const raw = Math.round(Math.max(0, Math.min(1, Number(fraction))) * 255);
    await this._command([[CMD.LIGHT_COLORTEMP, 1, raw]]);
  }

  async setRecirculate(on) {
    await this._command([[CMD.FAN_RECIRCULATE, 1, on ? 1 : 0]], CMD.STATUS_402);
  }

  async resetGreaseFilter() {
    await this._command([[CMD.RESET_GREASE, 0]], CMD.STATUS_402);
  }

  async pressPower() {
    await this._command([[CMD.POWER, 0]]);
  }

  async storeDefaultSpeed() {
    await this._command([[CMD.FAN_DEFAULT, 0]], CMD.STATUS_403);
  }

  async sendRawCommand(text) {
    const [cmd, ...args] = parseRawCommand(text);
    await this.client.connect();
    const reply = await this.client.send(cmd, ...args);
    this.log('Raw command reply', reply);
    await this.client.send(CMD.STATUS, 0).catch(this.error);
    return true;
  }

  // ---------------------------------------------------------------- dashboard widget

  getWidgetState() {
    const cap = c => (this.hasCapability(c) ? this.getCapabilityValue(c) : null);
    return {
      name: this.getName(),
      available: this._available,
      fanOn: !!cap('onoff'),
      fanSpeed: Math.round((cap('dim') || 0) * 100),
      status: cap('novy_status') || 'off',
      timer: cap('novy_timer') || 0,
      recirculate: cap('onoff.recirculate'),
      automode: cap('onoff.automode'),
      light: { ...this._light, brightness: Math.round((this._light.brightness / 255) * 100), colorTemp: Math.round((this._light.colorTemp / 255) * 100) },
      greaseDirty: !!cap('alarm_generic'),
      carbonDirty: !!cap('alarm_generic.carbon'),
      temperature: cap('measure_temperature'),
      humidity: cap('measure_humidity'),
      co2: cap('measure_co2'),
    };
  }

  async widgetAction(action, value) {
    switch (action) {
      case 'fan': return this.setFan(!!value);
      case 'speed': return this.setFanSpeed(value);
      case 'runon': return this.startDelayedOff();
      case 'light': return value ? this.lightOn(this._lightPreset()) : this.lightOff();
      case 'preset': return this.lightOn(value === 'ambi' ? 'ambi' : 'white');
      case 'brightness': return this.setLightBrightness(Number(value) / 100, this._lightPreset());
      case 'colortemp': return this.setLightTemperature(Number(value) / 100);
      case 'recirculate': return this.setRecirculate(!!value);
      case 'automode': return this.setAutomode(!!value);
      default: throw new Error(`Unknown action ${action}`);
    }
  }

  _lightPreset() {
    const light = this._lightDevice();
    return light ? light.getSetting('light_on_mode') || 'white' : 'white';
  }

  // ---------------------------------------------------------------- lifecycle

  async onSettings({ newSettings, changedKeys }) {
    this.log('Instellingen gewijzigd:', changedKeys.map(k => `${k}=${newSettings[k]}`).join(', '));
    if (changedKeys.includes('poll_interval') || changedKeys.includes('keep_connected')) {
      this._schedulePoll(1000);
    }
  }

  async onUninit() {
    this._stop();
    await this.client.disconnect().catch(() => {});
  }

  async onDeleted() {
    this._stop();
    const light = this._lightDevice();
    if (light) await light.setUnavailable(this.homey.__('error.no_hood')).catch(this.error);
    await this.client.disconnect().catch(() => {});
  }

  _stop() {
    this._deleted = true;
    if (this._pollTimer) this.homey.clearTimeout(this._pollTimer);
    this._pollTimer = null;
    this._cancelDelayedOff();
  }

}

module.exports = NovyHoodDevice;
