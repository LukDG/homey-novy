'use strict';

const Homey = require('homey');
const Logger = require('./lib/Logger');

class NovyApp extends Homey.App {

  async onInit() {
    // In-memory log (max 256 KB), on by default (setting 'log_enabled' is null until the user changes it).
    this.logger = new Logger({ timezone: this.homey.clock.getTimezone() });
    this.logger.setEnabled(this.homey.settings.get('log_enabled') !== false);
    this.logger.captureConsole();
    this.homey.settings.on('set', key => {
      if (key !== 'log_enabled') return;
      const on = this.homey.settings.get('log_enabled') !== false;
      if (on) this.logger.setEnabled(true);
      this.log(`Logboek ${on ? 'aangezet' : 'uitgezet'}`);
      if (!on) this.logger.setEnabled(false);
    });
    process.on('unhandledRejection', reason => this.error('Onverwerkte fout:', reason));

    const widget = this.homey.dashboards.getWidget('novy');
    widget.registerSettingAutocompleteListener('hood', async query => {
      const q = String(query || '').toLowerCase();
      return this.homey.drivers.getDriver('hood').getDevices()
        .filter(d => d.getName().toLowerCase().includes(q))
        .map(d => ({ name: d.getName(), description: d.getStoreValue('localName') || '', id: String(d.getData().id) }));
    });

    this.log('Novy (Bluetooth) app started');
  }

}

module.exports = NovyApp;
