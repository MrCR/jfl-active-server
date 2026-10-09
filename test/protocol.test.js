const assert = require('node:assert/strict');
const test = require('node:test');
const {
    eventFrameLength,
    parseEventClock,
    STATUS_FRAME,
    HANDSHAKE_FRAME,
    armFrame,
    disarmFrame,
    inhibitFrame,
    clearInhibitFrame,
    clockFrame,
    xorAll,
    parseStatus,
    panelMode,
    parseContactId,
    mqttPayload,
} = require('../api/protocol');

test('quadros capturados fecham o XOR', () => {
    assert.equal(STATUS_FRAME.toString('hex'), 'b33618000000009d');
    assert.equal(HANDSHAKE_FRAME.toString('hex'), 'b393000000000020');
    assert.equal(armFrame(1).toString('hex'), 'b336010100000085');
    assert.equal(disarmFrame(1).toString('hex'), 'b336020100000086');
    assert.equal(inhibitFrame([7]).toString('hex'), 'b3360540000000c0');
    assert.equal(inhibitFrame([1, 2]).toString('hex'), 'b336050300000083');
    assert.equal(clearInhibitFrame().toString('hex'), 'b336050000000080');
    for (const frame of [STATUS_FRAME, armFrame(1), disarmFrame(1), inhibitFrame([7])]) {
        assert.equal(xorAll(frame), 0);
    }
});

test('relógio tem 28 bytes e a ordem SS MM HH DD MM YY', () => {
    const frame = clockFrame(new Date(2026, 9, 8, 9, 32, 6));
    assert.equal(frame.length, 28);
    assert.equal(frame.subarray(0, 9).toString('hex'), 'b3cadb063209081026');
    assert.equal(xorAll(frame), 0);
});

test('zona acima de 8 não entra na máscara', () => {
    assert.throws(() => inhibitFrame([9]), /mascara/);
});

test('status de 66 bytes: relógio, bateria, rede e zona 7', () => {
    const frame = Buffer.alloc(66, 0);
    frame[0] = 0x36;
    frame[3] = 0x09;
    frame[4] = 0x32;
    frame[5] = 0x06;
    frame[6] = 0x08;
    frame[7] = 0x10;
    frame[8] = 0x26;
    frame[9] = 0xba;
    frame[11] = 0x80;
    frame[27] = 0x01;
    frame[31] = 0x88;
    frame[37] = 0x81;

    const status = parseStatus(frame);
    assert.deepEqual(status.clock, {
        hour: 9, minute: 32, second: 6, day: 8, month: 10, year: 2026,
    });
    assert.equal(status.batteryVolts, 13.3);
    assert.equal(status.trouble.ac, true);
    assert.equal(status.trouble.battery, false);
    assert.equal(status.partitions[0].state, 'disarmed');
    assert.equal(status.zones[6].state, 'inhibited');
    assert.equal(status.zones[0].state, 'closed');

    frame[27] = 0x82;
    frame[32] = 0x82;
    frame[37] = 0x82;
    frame[38] = 0x87;
    const triggered = parseStatus(frame);
    assert.equal(triggered.partitions[0].state, 'alarm');
    assert.equal(triggered.zones[1].state, 'alarm');
    assert.equal(triggered.zones[1].label, 'disparada');
    assert.equal(triggered.zones[6].state, 'alarm');
    assert.equal(triggered.zones[7].state, 'open');
    assert.equal(triggered.zones[7].label, 'aberta');
    assert.equal(panelMode(triggered), 'alarm');

    frame[9] = 0xb6;
    frame[11] = 0x40;
    const battery = parseStatus(frame);
    assert.equal(battery.batteryVolts, 13);
    assert.equal(battery.trouble.battery, true);

    frame[9] = 0x83;
    assert.equal(parseStatus(frame).batteryVolts, 9.4);
});

test('partição ainda não mapeada do stay do teclado continua com desarme', () => {
    const frame = Buffer.alloc(66, 0);
    frame[0] = 0x36;
    frame[27] = 0x03;
    frame[31] = 0x88;
    assert.equal(parseStatus(frame).partitions[0].state, 'unknown');
    assert.equal(panelMode(parseStatus(frame)), 'armed');
    frame[31] = 0x81;
    assert.equal(panelMode(parseStatus(frame)), 'stay');
    frame[27] = 0x00;
    frame[31] = 0x88;
    assert.equal(panelMode(parseStatus(frame)), 'unknown');
});

test('Contact ID no formato que o MQTT já publica', () => {
    const frame = Buffer.concat([
        Buffer.from('$00013401010011', 'ascii'),
        Buffer.from([0x00]),
    ]);
    const event = parseContactId(frame);
    const payload = mqttPayload({ ...event, timestamp: '2026-10-08T12:00:00.000Z' });
    assert.equal(payload.type, 'ARM');
    assert.equal(payload.event_code, '3401');
    assert.equal(payload.account_code, '0001');
    assert.equal(payload.qualifier_code, '01');
    assert.equal(payload.zone_user, '001');
    assert.equal(payload.timestamp, '2026-10-08T12:00:00.000Z');
    assert.equal(payload.raw_data.hex, frame.toString('hex'));
    assert.match(payload.message, /3401/);
    assert.equal(event.panelTime, null);
    assert.equal(eventFrameLength(frame), 16);
});

test('evento com relógio da central usa o carimbo, não a hora da chegada', () => {
    const frame = Buffer.concat([
        Buffer.from('$00011130010077', 'ascii'),
        Buffer.from([0x21]),
        Buffer.from([0x11, 0x18, 0x55, 0x08, 0x10, 0x26]),
    ]);
    const clock = parseEventClock(frame.subarray(16, 22));
    assert.equal(clock.hour, 11);
    assert.equal(clock.day, 8);
    assert.equal(clock.year, 2026);
    assert.equal(eventFrameLength(frame), 22);
    const event = parseContactId(frame);
    assert.equal(event.panelTime, '08/10/2026 11:18:55');
    assert.equal(event.timestamp, '2026-10-08T11:18:55-03:00');
    const next = Buffer.from('$00011130010077!', 'ascii');
    assert.equal(eventFrameLength(Buffer.concat([frame.subarray(0, 16), next])), 16);
});
