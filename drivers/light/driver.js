'use strict';

const Homey = require('homey');

/** The hood's lighting as its own device. It talks to the hood through the hood device. */
class NovyLightDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getActionCard('light_on_preset')
      .registerRunListener(args => args.device.turnOnPreset(args.preset));
    this.log('Novy light driver ready');
  }

  async onPairListDevices() {
    const taken = new Set(this.getDevices().map(d => d.getData().id));
    return this.homey.drivers.getDriver('hood').getDevices()
      .filter(hood => !taken.has(hood.getData().id))
      .map(hood => ({
        name: `${hood.getName()} – ${this.homey.__('light.name_suffix')}`,
        data: { id: hood.getData().id },
      }));
  }

}

module.exports = NovyLightDriver;
