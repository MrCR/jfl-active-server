const path = require('path');
const mqtt = require('mqtt');
const { createStore } = require('./db');
const { createPanel } = require('./panel');
const { createApi } = require('./http');
const { createJobs, zoneList } = require('./jobs');
const { sendTelegram, sendFcm, actionText, eventText } = require('./notify');
const { mqttPayload } = require('./protocol');

async function start(options = {}) {
    const panelPort = options.panelPort ?? Number(process.env.PANEL_PORT || 9999);
    const panelHost = options.panelHost ?? process.env.PANEL_HOST ?? '0.0.0.0';
    const apiPort = options.apiPort ?? Number(process.env.API_PORT || 8080);
    const apiHost = options.apiHost ?? process.env.API_HOST ?? '0.0.0.0';
    const dataFile = options.dataFile ?? process.env.DATA_FILE ?? path.join(process.cwd(), 'data', 'jfl.sqlite');
    const mqttBroker = options.mqttBroker === undefined
        ? (process.env.MQTT_BROKER === '' ? null : (process.env.MQTT_BROKER || 'mqtt://localhost:1883'))
        : options.mqttBroker;
    const mqttTopic = options.mqttTopic ?? process.env.MQTT_TOPIC ?? 'alarm/events';

    const store = createStore(dataFile);
    const notify = options.notify || (async (text) => {
        await sendTelegram(store, text);
        await sendFcm(store, text);
    });
    let mqttClient = null;

    function publish(event) {
        if (!mqttClient || !mqttClient.connected) return;
        mqttClient.publish(mqttTopic, JSON.stringify(event));
    }

    async function safeNotify(text) {
        try {
            await notify(text);
        } catch (error) {
            console.error(`Notificação: ${error.message}`);
        }
    }

    const panel = createPanel({
        store,
        statusTtlMs: options.statusTtlMs,
        commandTimeoutMs: options.commandTimeoutMs,
        onIdent: publish,
        onEvent(event, pending) {
            const attributed = pending && event.event_code !== '1570';
            store.insertEvent({
                at: event.timestamp,
                event_code: event.event_code,
                account_code: event.account_code,
                qualifier_code: event.qualifier_code,
                zone_user: event.zone_user,
                type: event.type,
                message: attributed
                    ? actionText(store, pending, pending.action, pending.zones)
                    : eventText(store, event),
                raw_hex: event.raw_data.hex,
                user_id: pending?.userId || null,
                actor_name: pending?.displayName || null,
            });
            publish(mqttPayload(event));
            if (pending) {
                if (panel.claimNotify(pending)) {
                    void safeNotify(actionText(store, pending, pending.action, pending.zones));
                }
                return;
            }
            void safeNotify(eventText(store, event));
        },
    });

    function finishAction(result, actor) {
        if (result?.pending && panel.claimNotify(result.pending)) {
            void safeNotify(actionText(store, actor, result.pending.action, result.pending.zones));
        }
        return api.enrich(result.status);
    }

    async function perform(schedule, actor) {
        const zones = zoneList(schedule.zones);
        let result;
        if (schedule.action === 'disarm') result = await panel.disarm(1, actor);
        else if (schedule.action === 'stay') {
            result = await panel.armInhibited(1, zones.length ? zones : store.stayZoneIds(), actor, 'stay');
        } else if (zones.length) result = await panel.armInhibited(1, zones, actor, 'arm');
        else result = await panel.arm(1, actor);
        finishAction(result, actor);
    }

    const jobs = createJobs({ store, panel, perform });
    const api = createApi({
        store,
        panel,
        finishAction,
        root: path.join(__dirname, '..'),
    });

    if (mqttBroker) {
        mqttClient = mqtt.connect(mqttBroker, { reconnectPeriod: 5000 });
        mqttClient.on('error', (error) => console.error(`MQTT: ${error.message}`));
        mqttClient.on('connect', () => console.log(`MQTT conectado em ${mqttBroker}, tópico ${mqttTopic}`));
    }

    const panelAddress = await panel.listen(panelPort, panelHost);
    const apiAddress = await api.listen(apiPort, apiHost);
    let timer = null;
    if (options.jobs !== false) {
        const tick = () => {
            jobs.runClock().catch((error) => console.error(error.message));
            jobs.runSchedules().catch((error) => console.error(error.message));
        };
        timer = setInterval(tick, options.jobIntervalMs || 20000);
        tick();
    }

    console.log(`Central em ${panelHost}:${panelAddress.port}`);
    console.log(`API em http://${apiHost}:${apiAddress.port}`);
    console.log('Status só é pedido enquanto o app chama /api/status');

    return {
        panel,
        api,
        store,
        jobs,
        panelPort: panelAddress.port,
        apiPort: apiAddress.port,
        async close() {
            if (timer) clearInterval(timer);
            await api.close();
            await panel.close();
            if (mqttClient) mqttClient.end(true);
            store.close();
        },
    };
}

if (require.main === module) {
    start().catch((error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`Porta em uso (${error.message}). Pare o proxy na 9999 antes de a API assumir a central.`);
        } else {
            console.error(error.message);
        }
        process.exit(1);
    });
}

module.exports = { start };
