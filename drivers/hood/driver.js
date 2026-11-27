'use strict';

const Homey = require('homey');
const NovyBleClient = require('../../lib/NovyBleClient');
const {
  CMD, NUS_SERVICE_UUID, NOVY_HOOD_ADV_UUID, NOVY_HOB_ADV_UUID, NOVY_LIGHTING_ADV_UUID, normalizeUuid, ackFields,
} = require('../../lib/NovyProtocol');

const NAME_PATTERN = /novy|pureline|cloud|intouch|hood/i;

class NovyHoodDriver extends Homey.Driver {

  async onInit() {
    this._registerFlowCards();
    this.log('Novy hood driver ready');
  }

  /**
   * Custom pairing:
   *   1. view asks 'scan'       -> list of candidate hoods
   *   2. view asks 'authorize'  -> Homey connects and keeps asking the hood for status
   *      while the user confirms on the remote / hood. Progress arrives in the view as
   *      'progress' and 'log' events; the result as 'authorized' or 'auth_failed'.
   */
  async onPair(session) {
    let advertisements = [];
    let attempt = null; // { cancelled, client }

    const stopAttempt = async () => {
      if (!attempt) return;
      attempt.cancelled = true;
      await attempt.client.disconnect().catch(() => {});
      attempt = null;
    };

    session.setHandler('scan', async () => {
      advertisements = await this.homey.ble.discover();
      this.log(`BLE scan: ${advertisements.length} peripheral(s)`);
      return advertisements
        .filter(adv => adv.localName || this._isNovy(adv))
        .map(adv => ({
          uuid: adv.uuid,
          name: adv.localName || '',
          address: adv.address || '',
          rssi: adv.rssi,
          novy: this._isNovy(adv),
        }))
        .sort((a, b) => (b.novy - a.novy) || ((b.rssi || -999) - (a.rssi || -999)));
    });

    session.setHandler('authorize', async ({ uuid, seconds, skip }) => {
      await stopAttempt();
      const adv = advertisements.find(a => a.uuid === uuid);
      if (!adv) throw new Error(this.homey.__('pair.not_found'));
      const client = new NovyBleClient({ homey: this.homey, peripheralUuid: uuid, log: (...a) => this.log(...a) });
      client.advertisement = adv;
      attempt = { cancelled: false, client };
      this._authorize(session, adv, attempt, Math.max(15, Number(seconds) || 90), skip === true).catch(this.error);
      return true;
    });

    session.setHandler('cancel', stopAttempt);
    session.setHandler('disconnect', stopAttempt);
  }

  /**
   * Same sequence as the official Novy app (LedVerificationActivity):
   *   [402;0]  read settings
   *   [39;0]   hood off
   *   [300;0]  hood waits for confirmation
   *   [301;1;0] every second until the hood answers "1" = user pressed on/off on the remote
   *   [213;0]  OEM id
   * With skip=true the confirmation is skipped (the official app also offers that).
   */
  async _authorize(session, adv, attempt, seconds, skip) {
    const { client } = attempt;
    const emit = (event, data) => session.emit(event, data).catch(() => {});
    const log = line => { this.log('[pair]', line); emit('log', line); };
    const sleep = ms => new Promise(resolve => this.homey.setTimeout(resolve, ms));
    const deadline = Date.now() + seconds * 1000;
    let armed = false;

    client.on('unsolicited', buf => log(`RX unsolicited: ${buf.toString('hex')} "${buf.toString('latin1').replace(/[^\x20-\x7e]/g, '.')}"`));
    log(`${adv.localName || '?'} ${adv.address || ''} rssi ${adv.rssi} services ${(adv.serviceUuids || []).join(',')}`);

    const send = async (cmd, ...args) => {
      const reply = await client.send(cmd, ...args);
      log(`[${[cmd, ...args].join(';')}] -> ${reply.type} ${reply.raw || ''}`);
      return reply;
    };

    while (!attempt.cancelled && Date.now() < deadline) {
      try {
        if (!client.isConnected) {
          emit('progress', { step: 'connecting' });
          await client.connect();
          log('connected');
          client.describeGatt().forEach(log);
          armed = false;
        }

        if (!skip && !armed) {
          await send(CMD.STATUS_402, 0).catch(err => log(`402: ${err.message}`));
          await send(CMD.HOOD_OFF, 0);
          await send(CMD.CODE_ON_LEDS, 0);
          armed = true;
          emit('progress', { step: 'press_remote' });
        }

        let confirmed = skip;
        if (!skip) {
          const reply = await send(CMD.CHECK_CODE, 1, 0);
          confirmed = reply.type === 'ack' && ackFields(reply.raw)[0] === '1';
        }

        if (confirmed) {
          if (!skip) await send(CMD.OEM_ID, 0).catch(() => {});
          const status = await send(CMD.STATUS, 0);
          if (status.type !== 'status') throw new Error('no status packet');
          let firmware = '-';
          const ext = await client.send(CMD.STATUS_402, 0).catch(() => null);
          if (ext && ext.type === 'status') firmware = ext.state.firmware;
          await client.disconnect().catch(() => {});
          if (attempt.cancelled) return;
          log(skip ? 'status ok (confirmation skipped)' : 'confirmed by remote');
          emit('authorized', {
            name: adv.localName || 'Novy',
            data: { id: adv.uuid },
            store: { address: adv.address || '', localName: adv.localName || '' },
            settings: { ble_address: adv.address || '-', ble_name: adv.localName || '-', firmware },
          });
          return;
        }
      } catch (err) {
        log(`error: ${err.message}`);
        if (!client.isConnected) await client.disconnect().catch(() => {});
        await sleep(2000);
        continue;
      }
      await sleep(1000);
    }

    await client.disconnect().catch(() => {});
    if (!attempt.cancelled) emit('auth_failed', {});
  }

  _isNovy(adv) {
    const services = (adv.serviceUuids || []).map(normalizeUuid);
    return [NOVY_HOOD_ADV_UUID, NUS_SERVICE_UUID, NOVY_HOB_ADV_UUID, NOVY_LIGHTING_ADV_UUID].some(u => services.includes(u))
      || NAME_PATTERN.test(adv.localName || '');
  }

  _registerFlowCards() {
    const action = (id, fn) => this.homey.flow.getActionCard(id)
      .registerRunListener(args => fn(args.device, args));
    const condition = (id, fn) => this.homey.flow.getConditionCard(id)
      .registerRunListener(args => fn(args.device, args));

    action('fan_speed_set', (device, args) => device.setFanSpeed(args.speed));
    action('fan_delayed_off', (device, args) => device.startDelayedOff(args.minutes));
    action('recirculate_set', (device, args) => device.setRecirculate(args.state === 'on'));
    action('reset_grease_filter', device => device.resetGreaseFilter());
    action('power_button', device => device.pressPower());
    action('store_default_speed', device => device.storeDefaultSpeed());
    action('send_raw_command', (device, args) => device.sendRawCommand(args.command));
    action('automode_set', (device, args) => device.setAutomode(args.state === 'on'));
    action('keylock_set', (device, args) => device.setKeylock(args.state === 'on'));
    action('reset_carbon_filter', device => device.resetCarbonFilter());

    condition('recirculate_is_on', device => device.getCapabilityValue('onoff.recirculate') === true);
    condition('automode_is_on', device => device.getCapabilityValue('onoff.automode') === true);
    condition('keylock_is_on', device => device.getCapabilityValue('onoff.keylock') === true);
    condition('status_is', (device, args) => device.getCapabilityValue('novy_status') === args.status);

    this.triggerStatusChanged = this.homey.flow.getDeviceTriggerCard('status_changed');
    this.triggerGreaseDirty = this.homey.flow.getDeviceTriggerCard('grease_filter_dirty');
    this.triggerCarbonDirty = this.homey.flow.getDeviceTriggerCard('carbon_filter_dirty');
  }

}

module.exports = NovyHoodDriver;
