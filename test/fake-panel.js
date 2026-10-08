const net = require('net');

function bcd(value) {
    return ((Math.floor(value / 10) % 10) << 4) | (value % 10);
}

function freshState() {
    const zones = Array(32).fill(0x00);
    for (const id of [1, 2, 3, 4, 7, 8]) zones[id - 1] = 0x88;
    return {
        partitions: [0x01, 0x01, 0x01, 0x01],
        zones,
        battery: 0xba,
        trouble: 0x00,
    };
}

function statusFrame(state) {
    const now = new Date();
    const frame = Buffer.alloc(66, 0);
    frame[0] = 0x36;
    frame[1] = 0xa0;
    frame[2] = 0x01;
    frame[3] = bcd(now.getHours());
    frame[4] = bcd(now.getMinutes());
    frame[5] = bcd(now.getSeconds());
    frame[6] = bcd(now.getDate());
    frame[7] = bcd(now.getMonth() + 1);
    frame[8] = bcd(now.getFullYear() % 100);
    frame[9] = state.battery;
    frame[11] = state.trouble;
    for (let index = 0; index < 4; index += 1) frame[27 + index] = state.partitions[index];
    for (let index = 0; index < 32; index += 1) frame[31 + index] = state.zones[index];
    frame[63] = 0x04;
    let checksum = 0;
    for (let index = 0; index < 65; index += 1) checksum ^= frame[index];
    frame[65] = checksum;
    return frame;
}

function contactId(code, zoneUser) {
    return Buffer.concat([
        Buffer.from(`$0001${code}01${zoneUser}1`, 'ascii'),
        Buffer.from([0x01]),
    ]);
}

function connectFake(port, options = {}) {
    const state = freshState();
    const received = [];
    const held = [];
    return new Promise((resolve, reject) => {
        const socket = net.connect({ port, host: '127.0.0.1' }, () => {
            const ident = Buffer.alloc(30, 0xff);
            ident[0] = 0x21;
            socket.write(ident);
        });
        let buffer = Buffer.alloc(0);
        let ready = false;

        function reply(frame) {
            if (frame[1] === 0x93) {
                const handshake = Buffer.alloc(14, 0);
                handshake[0] = 0x93;
                socket.write(handshake);
                return;
            }
            if (frame[1] === 0xca) {
                const clock = Buffer.alloc(27, 0);
                clock[0] = 0xca;
                socket.write(clock);
                return;
            }
            if (frame[1] !== 0x36) return;
            const command = frame[2];
            if (command === 0x01) {
                state.partitions[frame[3] - 1] = 0x02;
                if (options.emitRemoteArm) socket.write(contactId('3407', '099'));
            } else if (command === 0x02) {
                state.partitions[frame[3] - 1] = 0x01;
                for (let index = 0; index < 8; index += 1) {
                    if (state.zones[index] === 0x81) state.zones[index] = 0x88;
                }
            } else if (command === 0x05) {
                const mask = frame[3];
                for (let index = 0; index < 8; index += 1) {
                    if (state.zones[index] === 0x00) continue;
                    state.zones[index] = (mask & (1 << index)) ? 0x81 : 0x88;
                }
            }
            const write = () => socket.write(statusFrame(state));
            if (options.holdStatus && command === 0x18) held.push(write);
            else write();
        }

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length > 0) {
                if (buffer[0] === 0x2b) {
                    buffer = buffer.subarray(1);
                    continue;
                }
                if (buffer[0] === 0x40) {
                    if (buffer.length < 2) return;
                    buffer = buffer.subarray(2);
                    continue;
                }
                if (buffer[0] !== 0xb3) {
                    buffer = buffer.subarray(1);
                    continue;
                }
                if (buffer.length < 3) return;
                const length = buffer[1] === 0xca ? 28 : 8;
                if (buffer.length < length) return;
                const frame = Buffer.from(buffer.subarray(0, length));
                buffer = buffer.subarray(length);
                received.push(frame);
                reply(frame);
                if (!ready && frame[1] === 0x93) {
                    ready = true;
                    resolve({
                        socket,
                        received,
                        state,
                        release() {
                            const pending = held.splice(0);
                            for (const write of pending) write();
                        },
                        send(frame) {
                            socket.write(frame);
                        },
                    });
                }
            }
        });
        socket.on('error', reject);
    });
}

function statusCommands(received) {
    return received.filter((frame) => frame[1] === 0x36 && frame[2] === 0x18);
}

module.exports = { connectFake, contactId, statusCommands };
