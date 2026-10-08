#!/usr/bin/env node

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PROBE_PORT || 9999);
const HOST = '0.0.0.0';
const LOG_DIR = path.join(__dirname, 'logs');

const IDENTIFICATION_RESPONSE = Buffer.from([0x2b]);
const STANDARD_RESPONSE = Buffer.from([0x40, 0x05]);

const HEADER_7B = 0x7b;
const HEADER_B3 = 0xb3;
const MIN_FRAME = 5;
const MAX_FRAME = 255;

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
        case HEADER_7B:
            return 'candidato cabecalho 0x7B';
        case HEADER_B3:
            return 'candidato cabecalho 0xB3';
        default:
            return `outro 0x${byte.toString(16).padStart(2, '0')}`;
    }
}

function xorAll(buffer, start, length) {
    let value = 0;
    for (let index = start; index < start + length; index += 1) {
        value ^= buffer[index];
    }
    return value;
}

function findValidFrames(buffer, alreadyReported) {
    const found = [];
    for (let index = 0; index < buffer.length - 1; index += 1) {
        const header = buffer[index];
        if (header !== HEADER_7B && header !== HEADER_B3) {
            continue;
        }
        const length = buffer[index + 1];
        if (length < MIN_FRAME || length > MAX_FRAME || index + length > buffer.length) {
            continue;
        }
        if (xorAll(buffer, index, length) !== 0) {
            continue;
        }
        const key = `${index}:${length}:${header}`;
        if (alreadyReported.has(key)) {
            continue;
        }
        alreadyReported.add(key);
        found.push({
            offset: index,
            length,
            header,
            command: buffer[index + 3],
            sequence: buffer[index + 2]
        });
    }
    return found;
}

function ackFor(chunk) {
    return chunk[0] === 0x21 ? IDENTIFICATION_RESPONSE : STANDARD_RESPONSE;
}

let commandSeq = 1;

function nextSeq() {
    const value = commandSeq;
    commandSeq = value >= 0xff ? 1 : value + 1;
    return value;
}

function buildFrame(seq, cmd, payload = Buffer.alloc(0)) {
    const sequence = (seq & 0xff) || 0x01;
    const body = Buffer.concat([
        Buffer.from([HEADER_7B, 5 + payload.length, sequence, cmd]),
        payload
    ]);
    let checksum = 0;
    for (const byte of body) {
        checksum ^= byte;
    }
    return Buffer.concat([body, Buffer.from([checksum])]);
}

function loginFrame(seq) {
    const payload = Buffer.alloc(38, 0xff);
    payload[3] = 0x04;
    return buildFrame(seq, 0x43, payload);
}

function statusFrame(seq) {
    return buildFrame(seq, 0x4d);
}

fs.mkdirSync(LOG_DIR, { recursive: true });

const openLogs = new Set();
let connectionCount = 0;
let active = null;

const server = net.createServer((socket) => {
    connectionCount += 1;
    const started = new Date();
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    const logPath = path.join(LOG_DIR, `session-${fileStamp(started)}-${connectionCount}.log`);
    const log = fs.createWriteStream(logPath, { flags: 'a' });
    openLogs.add(log);

    const received = [];
    const reportedFrames = new Set();
    let bytes = 0;

    const write = (line = '') => {
        const text = `${line}\n`;
        process.stdout.write(text);
        log.write(text);
    };

    write(`=== sessao ${connectionCount} ===`);
    write(`inicio: ${stamp(started)}`);
    write(`origem: ${remote}`);
    write(`arquivo: ${logPath}`);
    write('ACK de identificacao e de evento. Comando 0x7B so sai se for pedido em 127.0.0.1:9998.');
    write('');

    active = { socket, write };

    socket.on('data', (chunk) => {
        const start = bytes;
        bytes += chunk.length;
        received.push(chunk);

        write(`--- rajada ${stamp()} offset=${start} bytes=${chunk.length} ---`);
        write(`primeiro byte: ${classifyFirstByte(chunk[0])}`);
        write(hexDump(chunk));

        const response = ackFor(chunk);
        socket.write(response);
        write(`ack enviado: ${response.toString('hex')}`);

        const pending = Buffer.concat(received);
        const frames = findValidFrames(pending, reportedFrames);
        for (const frame of frames) {
            const name = frame.header === HEADER_7B ? '0x7B' : '0xB3';
            write(
                `quadro ${name} valido (tamanho+XOR): ` +
                `offset=${frame.offset} tamanho=${frame.length} ` +
                `seq=0x${frame.sequence.toString(16).padStart(2, '0')} ` +
                `cmd=0x${frame.command.toString(16).padStart(2, '0')}`
            );
        }
        write('');
    });

    let closed = false;
    const closeLog = (reason) => {
        if (closed) {
            return;
        }
        closed = true;
        if (active && active.socket === socket) {
            active = null;
        }
        write(`fim: ${stamp()} motivo=${reason} total_bytes=${bytes}`);
        log.end();
        openLogs.delete(log);
    };

    socket.on('close', () => closeLog('close'));
    socket.on('error', (error) => {
        write(`erro no socket: ${error.message}`);
    });
});

server.on('error', (error) => {
    console.error(`Nao foi possivel escutar em ${HOST}:${PORT}: ${error.message}`);
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    const addresses = lanAddresses();
    console.log(`Sonda escutando em ${HOST}:${PORT}`);
    if (addresses.length === 0) {
        console.log('Nenhum IPv4 de LAN encontrado. Confira o endereco desta maquina.');
    } else {
        for (const address of addresses) {
            console.log(`Aponte a central para ${address} porta ${PORT} (enderecos 702 e 706)`);
        }
    }
    console.log(`Logs em ${LOG_DIR}`);
    console.log('So ACK. Ctrl+C encerra.');
});

net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (!buffer.includes('\n')) {
            return;
        }
        const command = buffer.trim().split(/\s+/)[0];
        buffer = '';
        if (!active || active.socket.destroyed) {
            socket.end('sem conexao com a central\n');
            return;
        }
        let frame = null;
        if (command === 'status') {
            frame = statusFrame(nextSeq());
        } else if (command === 'login') {
            frame = loginFrame(nextSeq());
        }
        if (!frame) {
            socket.end('use status ou login\n');
            return;
        }
        active.socket.write(frame);
        active.write(`comando manual: ${command} hex=${frame.toString('hex')}`);
        socket.end(`enviado ${frame.toString('hex')}\n`);
    });
}).listen(9998, '127.0.0.1');

function shutdown() {
    console.log('\nEncerrando sonda...');
    server.close();
    for (const log of openLogs) {
        log.end();
    }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
