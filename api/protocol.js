// Active 32 Duo, firmware 4.9. A central disca para ca.
// Identificacao 0x21 recebe '+'. Contact ID ('$') recebe 0x40 0x08.
// Comando: B3 | payload | XOR, e o XOR de todos os bytes fecha em zero.
// A resposta da central nao traz o prefixo 0xB3.

const IDENT_LENGTH = 30;
const STATUS_LENGTH = 66;
const HANDSHAKE_REPLY_LENGTH = 14;
const CLOCK_REPLY_LENGTH = 27;
const EVENT_LENGTH = 16;

const IDENT_ACK = Buffer.from([0x2b]);
const EVENT_ACK = Buffer.from([0x40, 0x08]);

const EVENT_TYPES = {
    3441: 'ARM',
    3401: 'ARM',
    3407: 'ARM',
    3409: 'ARM',
    1441: 'DISARM',
    1401: 'DISARM',
    1407: 'DISARM',
    1409: 'DISARM',
    1130: 'ALARM_TRIGGER',
    3130: 'ALARM_RESTORE',
    1301: 'AC_FAULT',
    3301: 'AC_RESTORE',
    1570: 'BYPASS',
};

const SYSTEM_EVENT_CODES = new Set(['3407', '1407', '1570']);

const ZONE_LABELS = {
    closed: 'fechada',
    open: 'aberta',
    alarm: 'disparada',
    inhibited: 'inibida',
    disabled: 'desabilitada',
    unknown: 'desconhecida',
};

const PARTITION_LABELS = {
    disarmed: 'desarmada',
    armed: 'armada',
    alarm: 'disparada',
    unknown: 'desconhecida',
};

function buildFrame(payload) {
    let checksum = 0xb3;
    for (const byte of payload) checksum ^= byte;
    return Buffer.from([0xb3, ...payload, checksum]);
}

function xorAll(buffer) {
    let checksum = 0;
    for (const byte of buffer) checksum ^= byte;
    return checksum;
}

function bcdByte(value) {
    const number = Number(value);
    return ((Math.floor(number / 10) % 10) << 4) | (number % 10);
}

function bcd(byte) {
    return ((byte >> 4) & 0x0f) * 10 + (byte & 0x0f);
}

const HANDSHAKE_FRAME = buildFrame([0x93, 0x00, 0x00, 0x00, 0x00, 0x00]);
const STATUS_FRAME = buildFrame([0x36, 0x18, 0x00, 0x00, 0x00, 0x00]);

function armFrame(partition) {
    return buildFrame([0x36, 0x01, partition, 0x00, 0x00, 0x00]);
}

function disarmFrame(partition) {
    return buildFrame([0x36, 0x02, partition, 0x00, 0x00, 0x00]);
}

function inhibitFrame(zones) {
    let mask = 0;
    const unique = [...new Set(zones)];
    for (const zone of unique) {
        if (!Number.isInteger(zone) || zone < 1 || zone > 8) {
            const error = new Error(`zona ${zone} fora da mascara de 8 bits`);
            error.statusCode = 400;
            throw error;
        }
        mask |= 1 << (zone - 1);
    }
    return buildFrame([0x36, 0x05, mask, 0x00, 0x00, 0x00]);
}

function clearInhibitFrame() {
    return inhibitFrame([]);
}

function clockFrame(date) {
    const payload = [
        0xca,
        0xdb,
        bcdByte(date.getSeconds()),
        bcdByte(date.getMinutes()),
        bcdByte(date.getHours()),
        bcdByte(date.getDate()),
        bcdByte(date.getMonth() + 1),
        bcdByte(date.getFullYear() % 100),
        ...Array(18).fill(0),
    ];
    return buildFrame(payload);
}

function zoneState(raw) {
    if (raw === 0x88) return 'closed';
    if (raw === 0x87) return 'open';
    if (raw === 0x82) return 'alarm';
    if (raw === 0x81) return 'inhibited';
    if (raw === 0x00) return 'disabled';
    return 'unknown';
}

function partitionState(raw) {
    if (raw === 0x01) return 'disarmed';
    if (raw === 0x02) return 'armed';
    if (raw === 0x82) return 'alarm';
    return 'unknown';
}

function parseStatus(frame) {
    if (frame.length !== STATUS_LENGTH || frame[0] !== 0x36) {
        throw new Error('resposta de status invalida');
    }

    const trouble = frame[11];
    const partitions = [];
    for (let index = 0; index < 4; index += 1) {
        const raw = frame[27 + index];
        const state = partitionState(raw);
        partitions.push({
            id: index + 1,
            raw,
            state,
            label: PARTITION_LABELS[state],
        });
    }

    const zones = [];
    for (let index = 0; index < 32; index += 1) {
        const raw = frame[31 + index];
        const state = zoneState(raw);
        zones.push({
            id: index + 1,
            raw,
            state,
            label: ZONE_LABELS[state],
        });
    }

    return {
        clock: {
            hour: bcd(frame[3]),
            minute: bcd(frame[4]),
            second: bcd(frame[5]),
            day: bcd(frame[6]),
            month: bcd(frame[7]),
            year: 2000 + bcd(frame[8]),
        },
        batteryVolts: Math.round((frame[9] / 14) * 10) / 10,
        trouble: {
            ac: (trouble & 0x80) !== 0,
            battery: (trouble & 0x40) !== 0,
            raw: trouble,
        },
        partitions,
        zones,
        raw: frame.toString('hex'),
    };
}

function eventMessage(type, eventCode, zoneUser) {
    const zone = Number.parseInt(zoneUser, 10);
    switch (type) {
        case 'ARM':
            return `Sistema armado - Código: ${eventCode}, Zona/Usuário: ${zone}`;
        case 'DISARM':
            return `Sistema desarmado - Código: ${eventCode}, Zona/Usuário: ${zone}`;
        case 'ALARM_TRIGGER':
            return `Alarme disparado - Zona: ${zone}`;
        case 'ALARM_RESTORE':
            return `Alarme restaurado - Zona: ${zone}`;
        case 'AC_FAULT':
            return `Falha de energia - Código: ${eventCode}`;
        case 'AC_RESTORE':
            return `Energia restaurada - Código: ${eventCode}`;
        case 'BYPASS':
            return `Zona inibida - Zona: ${zone}`;
        default:
            return `Evento desconhecido: ${eventCode}`;
    }
}

function parseContactId(frame) {
    const ascii = frame.toString('ascii');
    if (frame[0] !== 0x24 || ascii.length < 15) return null;

    const eventCode = ascii.substring(5, 9);
    const type = EVENT_TYPES[eventCode] || 'UNKNOWN';
    const zoneUser = ascii.substring(11, 14);

    return {
        type,
        event_code: eventCode,
        account_code: ascii.substring(1, 5),
        qualifier_code: ascii.substring(9, 11),
        zone_user: zoneUser,
        message: eventMessage(type, eventCode, zoneUser),
        raw_data: {
            hex: frame.toString('hex'),
            ascii,
        },
    };
}

function mqttPayload(event) {
    return {
        type: event.type,
        event_code: event.event_code,
        account_code: event.account_code,
        qualifier_code: event.qualifier_code,
        zone_user: event.zone_user,
        message: event.message,
        timestamp: event.timestamp,
        raw_data: event.raw_data,
    };
}

function frameKind(byte) {
    if (byte === 0x21) return { kind: 'ident', length: IDENT_LENGTH };
    if (byte === 0x24) return { kind: 'event', length: EVENT_LENGTH };
    if (byte === 0x36) return { kind: 'status', length: STATUS_LENGTH };
    if (byte === 0x93) return { kind: 'handshake', length: HANDSHAKE_REPLY_LENGTH };
    if (byte === 0xca) return { kind: 'clock', length: CLOCK_REPLY_LENGTH };
    return null;
}

function panelMode(status) {
    const partition = status.partitions?.find((item) => item.id === 1);
    if (!partition || partition.state === 'unknown') return 'unknown';
    if (partition.state === 'alarm' || status.zones?.some((zone) => zone.state === 'alarm')) return 'alarm';
    if (partition.state === 'disarmed') return 'disarmed';
    if (status.zones?.some((zone) => zone.state === 'inhibited')) return 'stay';
    return 'armed';
}

module.exports = {
    IDENT_ACK,
    EVENT_ACK,
    HANDSHAKE_FRAME,
    STATUS_FRAME,
    SYSTEM_EVENT_CODES,
    buildFrame,
    xorAll,
    armFrame,
    disarmFrame,
    inhibitFrame,
    clearInhibitFrame,
    clockFrame,
    parseStatus,
    parseContactId,
    mqttPayload,
    frameKind,
    panelMode,
    eventMessage,
};
