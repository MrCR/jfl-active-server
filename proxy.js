#!/usr/bin/env node

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const LISTEN_HOST = '0.0.0.0';
const LISTEN_PORT = Number(process.env.PROXY_LISTEN || 9999);
const UPSTREAM_HOST = process.argv[2] || process.env.PROXY_UPSTREAM_HOST || '127.0.0.1';
const UPSTREAM_PORT = Number(process.argv[3] || process.env.PROXY_UPSTREAM_PORT || 10000);
const LOG_DIR = path.join(__dirname, 'logs');
const STATUS_INTERVAL_MS = Number(process.env.PROXY_STATUS_MS || 10000);
const STATUS_FRAME = Buffer.from('b33618000000009d', 'hex');

function buildFrame(payload) {
    let checksum = 0xb3;
    for (const byte of payload) {
        checksum ^= byte;
    }
    return Buffer.concat([Buffer.from([0xb3]), Buffer.from(payload), Buffer.from([checksum])]);
}

function frameFor(command) {
    if (command === 'status') {
        return STATUS_FRAME;
    }
    if (command === 'arm') {
        return buildFrame([0x36, 0x01, 0x01, 0x00, 0x00, 0x00]);
    }
    if (command === 'disarm') {
        return buildFrame([0x36, 0x02, 0x01, 0x00, 0x00, 0x00]);
    }
    if (command === 'clear') {
        return buildFrame([0x36, 0x05, 0x00, 0x00, 0x00, 0x00]);
    }
    const inhibit = /^inhibit (\d+)$/.exec(command);
    if (inhibit) {
        const zone = Number(inhibit[1]);
        if (zone < 1 || zone > 8) {
            return null;
        }
        return buildFrame([0x36, 0x05, 1 << (zone - 1), 0x00, 0x00, 0x00]);
    }
    return null;
}

function stamp(date = new Date()) {
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate())
    ].join('-') + ' ' + [
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
    ].join(':') + '.' + pad(date.getMilliseconds(), 3);
}

function fileStamp(date = new Date()) {
    return stamp(date).replace(/[-: ]/g, '').replace('.', '');
}

function lanAddresses() {
    const addresses = [];
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries || []) {
            if (entry.family === 'IPv4' && !entry.internal) {
                addresses.push(entry.address);
            }
        }
    }
    return addresses;
}

function printable(buffer) {
    return [...buffer].map((byte) => (
        byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.'
    )).join('');
}

function hexDump(buffer) {
    const lines = [];
    for (let offset = 0; offset < buffer.length; offset += 16) {
        const slice = buffer.subarray(offset, offset + 16);
        const hex = [...slice].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
        lines.push(
            `    ${offset.toString(16).padStart(4, '0')}  ${hex.padEnd(47, ' ')}  ${printable(slice)}`
        );
    }
    return lines.join('\n');
}

function classifyFirstByte(byte) {
    switch (byte) {
        case 0x21:
            return 'identificacao 0x21';
        case 0x24:
            return 'contact-id $';
        case 0x2b:
            return 'ack +';
        case 0x40:
            return 'ack 0x40';
        case 0x7b:
            return 'cabecalho 0x7B';
        case 0xb3:
            return 'cabecalho 0xB3';
        default:
            return `outro 0x${byte.toString(16).padStart(2, '0')}`;
    }
}

fs.mkdirSync(LOG_DIR, { recursive: true });

let connectionCount = 0;
const openLogs = new Set();
let active = null;

function attachSession(panel) {
    connectionCount += 1;
    const started = new Date();
    const remote = `${panel.remoteAddress}:${panel.remotePort}`;
    const logPath = path.join(LOG_DIR, `proxy-${fileStamp(started)}-${connectionCount}.log`);
    const log = fs.createWriteStream(logPath, { flags: 'a' });
    openLogs.add(log);

    let panelBytes = 0;
    let softwareBytes = 0;
    let closed = false;
    const pending = [];
    let upstreamReady = false;
    let pollTimer = null;

    const write = (line = '') => {
        const text = `${line}\n`;
        process.stdout.write(text);
        log.write(text);
    };

    const finish = (reason) => {
        if (closed) {
            return;
        }
        closed = true;
        clearInterval(pollTimer);
        if (active && active.panel === panel) {
            active = null;
        }
        write(`fim: ${stamp()} motivo=${reason} central_bytes=${panelBytes} software_bytes=${softwareBytes}`);
        log.end();
        openLogs.delete(log);
        panel.destroy();
        upstream.destroy();
    };

    write(`=== proxy ${connectionCount} ===`);
    write(`inicio: ${stamp(started)}`);
    write(`central: ${remote}`);
    write(`software: ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
    write(`arquivo: ${logPath}`);
    write(`bytes repassados sem alteracao; status proprio a cada ${STATUS_INTERVAL_MS} ms`);
    write('');

    const upstream = net.connect({ host: UPSTREAM_HOST, port: UPSTREAM_PORT });

    const forward = (direction, chunk, target, ready) => {
        const fromPanel = direction.startsWith('central');
        if (fromPanel) {
            panelBytes += chunk.length;
        } else {
            softwareBytes += chunk.length;
        }
        write(`--- ${direction} ${stamp()} bytes=${chunk.length} ---`);
        write(`primeiro byte: ${classifyFirstByte(chunk[0])}`);
        write(hexDump(chunk));
        write('');
        if (!ready) {
            pending.push(chunk);
            return;
        }
        if (!target.destroyed) {
            target.write(chunk);
        }
    };

    const sendFrame = (label, frame) => {
        if (closed || panel.destroyed) {
            return false;
        }
        panel.write(frame);
        write(`--- sonda -> central ${stamp()} bytes=${frame.length} ---`);
        write(label);
        write(hexDump(frame));
        write('');
        return true;
    };

    const requestStatus = () => sendFrame('pedido de status', STATUS_FRAME);
    active = {
        panel,
        send(command) {
            const frame = frameFor(command);
            if (!frame) {
                return false;
            }
            return sendFrame(`comando ${command}`, frame);
        }
    };

    panel.on('data', (chunk) => {
        forward('central -> software', chunk, upstream, upstreamReady);
        if (!pollTimer && chunk[0] === 0x21) {
            pollTimer = setInterval(requestStatus, STATUS_INTERVAL_MS);
            setTimeout(requestStatus, 1000);
        }
    });
    upstream.on('data', (chunk) => forward('software -> central', chunk, panel, true));

    upstream.on('connect', () => {
        upstreamReady = true;
        write(`software conectado: ${stamp()}`);
        write('');
        while (pending.length > 0 && !upstream.destroyed) {
            upstream.write(pending.shift());
        }
    });

    panel.on('close', () => finish('central fechou'));
    upstream.on('close', () => finish('software fechou'));
    panel.on('error', (error) => {
        write(`erro na central: ${error.message}`);
        finish('erro na central');
    });
    upstream.on('error', (error) => {
        write(`erro no software: ${error.message}`);
        finish('erro no software');
    });
}

net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (!buffer.includes('\n')) {
            return;
        }
        const command = buffer.trim();
        buffer = '';
        if (!active) {
            socket.end('sem conexao\n');
            return;
        }
        socket.end(active.send(command) ? `enviado ${command}\n` : `comando desconhecido: ${command}\n`);
    });
}).listen(9998, '127.0.0.1');

const server = net.createServer(attachSession);

server.on('error', (error) => {
    console.error(`Nao foi possivel escutar em ${LISTEN_HOST}:${LISTEN_PORT}: ${error.message}`);
    process.exit(1);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`Proxy escutando em ${LISTEN_HOST}:${LISTEN_PORT}`);
    console.log(`Encaminha para ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
    for (const address of lanAddresses()) {
        console.log(`A central continua em ${address} porta ${LISTEN_PORT}`);
    }
    console.log(`Logs em ${LOG_DIR}`);
    console.log(`Status proprio a cada ${STATUS_INTERVAL_MS} ms. Ctrl+C encerra.`);
});

function shutdown() {
    console.log('\nEncerrando proxy...');
    server.close();
    for (const log of openLogs) {
        log.end();
    }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
