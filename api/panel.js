const net = require('net');
const {
    IDENT_ACK,
    EVENT_ACK,
    HANDSHAKE_FRAME,
    STATUS_FRAME,
    SYSTEM_EVENT_CODES,
    armFrame,
    disarmFrame,
    inhibitFrame,
    clearInhibitFrame,
    clockFrame,
    parseStatus,
    parseContactId,
    frameKind,
    panelMode,
} = require('./protocol');

const ACTION_WINDOW_MS = 15000;

function fail(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function createPanel({ store, statusTtlMs = 10000, commandTimeoutMs = 12000, onEvent, onIdent }) {
    const link = {
        server: null,
        socket: null,
        buffer: Buffer.alloc(0),
        generation: 0,
        tail: Promise.resolve(),
        refreshing: null,
        waiter: null,
        snapshot: null,
        cacheAt: 0,
        lastEvent: null,
        pending: [],
        statusTtlMs,
        commandTimeoutMs,
    };

    function enqueue(task) {
        const run = link.tail.then(task, task);
        link.tail = run.then(() => {}, () => {});
        return run;
    }

    function failWaiter(error) {
        const waiter = link.waiter;
        link.waiter = null;
        if (waiter) waiter.reject(error);
    }

    function waitFor(kind, generation) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (link.waiter && link.waiter.generation === generation) link.waiter = null;
                reject(fail('a central nao respondeu', 504));
            }, link.commandTimeoutMs);
            link.waiter = {
                kind,
                generation,
                resolve: (frame) => {
                    clearTimeout(timer);
                    resolve(frame);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            };
        });
    }

    function present(fromCache) {
        const status = {
            connected: Boolean(link.socket && !link.socket.destroyed),
            fromCache,
            ageMs: link.cacheAt ? Date.now() - link.cacheAt : null,
            updatedAt: link.cacheAt ? new Date(link.cacheAt).toISOString() : null,
            lastEvent: link.lastEvent,
            clock: null,
            batteryVolts: null,
            trouble: null,
            partitions: [],
            zones: [],
            ...(link.snapshot || {}),
        };
        status.mode = panelMode(status);
        return status;
    }

    function applyStatus(frame) {
        link.snapshot = parseStatus(frame);
        link.cacheAt = Date.now();
        store.rememberZoneStates(link.snapshot.zones);
        return present(false);
    }

    function connected() {
        return Boolean(link.socket && !link.socket.destroyed);
    }

    function notePending(actor, action, zones) {
        const pending = {
            at: Date.now(),
            userId: actor?.id || null,
            displayName: actor?.displayName || 'Sistema',
            source: actor?.source || 'api',
            action,
            zones: zones || [],
            notified: false,
        };
        link.pending.push(pending);
        link.pending = link.pending.filter((item) => Date.now() - item.at < ACTION_WINDOW_MS);
        return pending;
    }

    function claimNotify(pending) {
        if (!pending || pending.notified) return false;
        pending.notified = true;
        return true;
    }

    function eventFits(pending, event) {
        if (event.event_code === '1570') {
            return (pending.action === 'arm' || pending.action === 'stay') && !pending.sawBypass;
        }
        if (event.event_code === '3407') return (pending.action === 'arm' || pending.action === 'stay') && !pending.matched;
        if (event.event_code === '1407') return pending.action === 'disarm' && !pending.matched;
        return false;
    }

    function matchPending(event) {
        if (!SYSTEM_EVENT_CODES.has(event.event_code)) return null;
        const now = Date.now();
        link.pending = link.pending.filter((item) => now - item.at < ACTION_WINDOW_MS);
        for (let index = link.pending.length - 1; index >= 0; index -= 1) {
            const pending = link.pending[index];
            if (!eventFits(pending, event)) continue;
            if (event.event_code === '1570') pending.sawBypass = true;
            else pending.matched = true;
            return pending;
        }
        return null;
    }

    async function roundTrip(frame, action, actor, kind) {
        const socket = link.socket;
        const generation = link.generation;
        if (!socket || socket.destroyed) throw fail('central desconectada', 503);

        const pending = waitFor(kind, generation);
        try {
            socket.write(frame);
        } catch (error) {
            failWaiter(error);
            throw error;
        }
        store.recordCall({
            userId: actor?.id || null,
            source: 'panel',
            action,
            detail: frame.toString('hex'),
            ok: 1,
        });

        const reply = await pending;
        if (generation !== link.generation) throw fail('central reconectou', 503);
        if (kind === 'status') return applyStatus(reply);
        return { ok: true };
    }

    function getStatus() {
        if (link.refreshing) return link.refreshing;
        const age = link.cacheAt ? Date.now() - link.cacheAt : Infinity;
        if (!connected()) return Promise.resolve(present(Boolean(link.snapshot)));
        if (link.snapshot && age < link.statusTtlMs) return Promise.resolve(present(true));

        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        link.refreshing = promise;
        enqueue(() => roundTrip(STATUS_FRAME, 'status', null, 'status'))
            .then(resolve, reject)
            .finally(() => {
                if (link.refreshing === promise) link.refreshing = null;
            });
        return promise;
    }

    function handleIdent(socket, frame) {
        socket.write(IDENT_ACK);
        socket.write(HANDSHAKE_FRAME);
        store.recordCall({ source: 'panel', action: 'ident', ok: 1 });
        if (onIdent) {
            onIdent({
                type: 'IDENTIFICATION',
                timestamp: new Date().toISOString(),
                raw_data: {
                    hex: frame.toString('hex'),
                    ascii: frame.toString('ascii'),
                },
            });
        }
    }

    function onEventFrame(socket, frame) {
        socket.write(EVENT_ACK);
        const event = parseContactId(frame);
        if (!event) return;
        event.timestamp = new Date().toISOString();
        link.lastEvent = {
            type: event.type,
            event_code: event.event_code,
            zone_user: event.zone_user,
            at: event.timestamp,
        };
        try {
            if (onEvent) onEvent(event, matchPending(event));
        } catch (error) {
            console.error(`Evento: ${error.message}`);
        }
    }

    function onStatusFrame(frame) {
        if (link.waiter && link.waiter.kind === 'status') {
            const waiter = link.waiter;
            link.waiter = null;
            waiter.resolve(frame);
            return;
        }
        applyStatus(frame);
    }

    function onClockFrame(frame) {
        if (link.waiter && link.waiter.kind === 'clock') {
            const waiter = link.waiter;
            link.waiter = null;
            waiter.resolve(frame);
        }
    }

    function feed(socket, chunk) {
        link.buffer = Buffer.concat([link.buffer, chunk]);
        while (link.buffer.length > 0 && link.socket === socket) {
            const header = frameKind(link.buffer[0]);
            if (!header) {
                link.buffer = link.buffer.subarray(1);
                continue;
            }
            if (link.buffer.length < header.length) return;
            const frame = Buffer.from(link.buffer.subarray(0, header.length));
            link.buffer = link.buffer.subarray(header.length);
            if (header.kind === 'ident') handleIdent(socket, frame);
            else if (header.kind === 'event') onEventFrame(socket, frame);
            else if (header.kind === 'status') onStatusFrame(frame);
            else if (header.kind === 'clock') onClockFrame(frame);
        }
    }

    function accept(socket) {
        link.generation += 1;
        failWaiter(fail('central reconectou', 503));
        if (link.socket) link.socket.destroy();
        link.socket = socket;
        link.buffer = Buffer.alloc(0);
        socket.setKeepAlive(true);
        socket.on('data', (chunk) => feed(socket, chunk));
        socket.on('error', () => {});
        socket.on('close', () => {
            if (link.socket !== socket) return;
            link.socket = null;
            failWaiter(fail('central desconectada', 503));
            console.log('Central desconectou');
        });
        console.log(`Central conectou de ${socket.remoteAddress}`);
    }

    function assertPartition(partition) {
        if (!Number.isInteger(partition) || partition < 1 || partition > 4) {
            throw fail('particao invalida', 400);
        }
    }

    async function runAction(actor, action, zones, task) {
        const pending = notePending(actor, action, zones);
        try {
            const status = await enqueue(task);
            return { status, pending };
        } catch (error) {
            link.pending = link.pending.filter((item) => item !== pending);
            throw error;
        }
    }

    return {
        listen(port, host) {
            link.server = net.createServer(accept);
            return new Promise((resolve, reject) => {
                link.server.once('error', reject);
                link.server.listen(port, host, () => {
                    link.server.off('error', reject);
                    resolve(link.server.address());
                });
            });
        },
        connected,
        getStatus,
        present,
        claimNotify,
        arm(partition, actor) {
            assertPartition(partition);
            return runAction(actor, 'arm', [], () => roundTrip(armFrame(partition), 'arm', actor, 'status'));
        },
        disarm(partition, actor) {
            assertPartition(partition);
            return runAction(actor, 'disarm', [], () => roundTrip(disarmFrame(partition), 'disarm', actor, 'status'));
        },
        async armInhibited(partition, zones, actor, action = 'arm') {
            assertPartition(partition);
            if (!Array.isArray(zones) || zones.some((zone) => !Number.isInteger(zone))) {
                throw fail('informe zones, uma lista de zonas de 1 a 8', 400);
            }
            if (zones.length === 0 && action !== 'stay') {
                throw fail('informe zones, uma lista de zonas de 1 a 8', 400);
            }
            const frame = zones.length > 0 ? inhibitFrame(zones) : null;
            return runAction(actor, action, zones, async () => {
                if (frame) await roundTrip(frame, 'inhibit', actor, 'status');
                return roundTrip(armFrame(partition), 'arm', actor, 'status');
            });
        },
        clearZones(actor) {
            return runAction(actor, 'clear', [], () => roundTrip(clearInhibitFrame(), 'clear', actor, 'status'));
        },
        setClock(date, actor) {
            return enqueue(() => roundTrip(clockFrame(date), 'clock', actor, 'clock'));
        },
        close() {
            failWaiter(fail('servidor encerrado', 503));
            if (link.socket) link.socket.destroy();
            if (!link.server) return Promise.resolve();
            return new Promise((resolve) => link.server.close(() => resolve()));
        },
    };
}

module.exports = { createPanel };
