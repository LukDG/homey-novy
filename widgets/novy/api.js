'use strict';

function findHood(homey, id) {
  const devices = homey.drivers.getDriver('hood').getDevices();
  if (!devices.length) throw new Error(homey.__('widget.nohood'));
  if (!id) return devices[0];
  const device = devices.find(d => String(d.getData().id) === String(id));
  if (!device) throw new Error(homey.__('widget.nohood'));
  return device;
}

module.exports = {
  async getState({ homey, query }) {
    return findHood(homey, query.id).getWidgetState();
  },

  async action({ homey, body }) {
    const { id, action, value } = body || {};
    await findHood(homey, id).widgetAction(action, value);
    return { ok: true };
  },
};
