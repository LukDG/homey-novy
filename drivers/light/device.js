'use strict';

const Homey = require('homey');

/**
 * Lighting of a Novy hood. Has no Bluetooth connection of its own: commands go through the
 * hood device with the same id, which pushes the light state back here after every poll.
 */
class NovyLightDevice extends Homey.Device {

  async onInit() {
    this.registerCapabilityListener('onoff', value => this._withHood(hood => (
      value ? hood.lightOn(this._preset()) : hood.lightOff())));
    this.registerCapabilityListener('dim', value => this._withHood(hood => hood.setLightBrightness(value, this._preset())));
    this.registerCapabilityListener('light_temperature', value => this._withHood(hood => hood.setLightTemperature(value)));

    const hood = this._hood();
    if (hood) await this.syncFromHood(hood);
    else await this.setUnavailable(this.homey.__('error.no_hood')).catch(this.error);
    this.log('Novy light initialised', this.getName());
  }

  _hood() {
    const id = this.getData().id;
    return this.homey.drivers.getDriver('hood').getDevices().find(d => d.getData().id === id) || null;
  }

  _preset() {
    return this.getSetting('light_on_mode') === 'ambi' ? 'ambi' : 'white';
  }

  async _withHood(fn) {
    const hood = this._hood();
    if (!hood) throw new Error(this.homey.__('error.no_hood'));
    return fn(hood);
  }

  async turnOnPreset(preset) {
    return this._withHood(hood => hood.lightOn(preset === 'ambi' ? 'ambi' : 'white'));
  }

  /** Called by the hood device after every status update. */
  async syncFromHood(hood) {
    const light = hood.getLightState();
    if (!hood.isHoodAvailable()) {
      if (this.getAvailable()) await this.setUnavailable(this.homey.__('error.unreachable')).catch(this.error);
      return;
    }
    if (!this.getAvailable()) await this.setAvailable().catch(this.error);
    const set = (cap, value) => (this.getCapabilityValue(cap) === value ? null
      : this.setCapabilityValue(cap, value).catch(this.error));
    await Promise.all([
      set('onoff', light.on),
      light.on ? set('dim', Math.round((light.brightness / 255) * 100) / 100) : null,
      set('light_temperature', Math.round((light.colorTemp / 255) * 100) / 100),
    ]);
  }

}

module.exports = NovyLightDevice;
