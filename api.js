'use strict';

/** Web API for the app settings page (settings/index.html). */
module.exports = {
  async getLog({ homey }) {
    return homey.app.logger.read();
  },

  async clearLog({ homey }) {
    homey.app.logger.clear();
    return homey.app.logger.read();
  },
};
