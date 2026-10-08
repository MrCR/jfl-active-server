const fs = require('fs');
const http = require('http');
const path = require('path');
const { verifyPassword } = require('./auth');
const { hashPassword } = require('./auth');
const { panelMode } = require('./protocol');

const STATIC = {
    '/': ['web', 'index.html', 'text/html; charset=utf-8'],
    '/app.js': ['web', 'app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['web', 'style.css', 'text/css; charset=utf-8'],
    '/admin/': ['admin', 'index.html', 'text/html; charset=utf-8'],
    '/admin/app.js': ['admin', 'app.js', 'text/javascript; charset=utf-8'],
    '/admin/style.css': ['admin', 'style.css', 'text/css; charset=utf-8'],
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 1_000_000) {
                reject(Object.assign(new Error('corpo grande demais'), { statusCode: 400 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function send(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    });
    res.end(payload);
}

function bearer(req) {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function fail(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function normalizeZones(value) {
    const list = Array.isArray(value) ? value : String(value || '').split(',');
    return list.map((zone) => Number(zone)).filter((zone) => Number.isInteger(zone) && zone > 0);
}

function normalizeSchedule(body) {
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) throw fail('informe o nome', 400);
    if (!['arm', 'disarm', 'stay'].includes(body.action)) throw fail('acao invalida', 400);
    const runOnce = Boolean(body.runOnce);
    let time = '';
    let days = '';
    let onceAt = '';
    if (runOnce) {
        onceAt = String(body.onceAt || '');
        if (Number.isNaN(new Date(onceAt).getTime())) throw fail('data invalida', 400);
    } else {
        time = String(body.time || '');
        if (!/^\d{2}:\d{2}$/.test(time)) throw fail('horario invalido', 400);
        const source = Array.isArray(body.days) ? body.days : String(body.days || '').split(',');
        const dayList = source.map((day) => Number(day)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
        if (dayList.length === 0) throw fail('escolha ao menos um dia', 400);
        days = [...new Set(dayList)].join(',');
    }
    const zones = normalizeZones(body.zones);
    if (zones.some((zone) => zone > 8)) throw fail('inibicao so aceita zonas de 1 a 8', 400);
    return {
        name,
        action: body.action,
        time,
        days,
        runOnce,
        onceAt,
        zones: zones.join(','),
        enabled: body.enabled !== false,
    };
}

function createApi({ store, panel, finishAction, root }) {
    function enrich(status) {
        const catalog = new Map(store.listZones().map((zone) => [zone.zone, zone]));
        const zones = (status.zones || []).map((zone) => ({
            ...zone,
            name: catalog.get(zone.id)?.name || `Zona ${zone.id}`,
            stay: Boolean(catalog.get(zone.id)?.stay),
        }));
        const next = { ...status, zones };
        delete next.raw;
        next.mode = panelMode(next);
        return next;
    }

    function userFrom(req) {
        return store.sessionUser(bearer(req));
    }

    async function handle(req, res) {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'OPTIONS') {
            send(res, 204, {});
            return;
        }
        if (req.method === 'GET' && url.pathname === '/admin') {
            res.writeHead(308, { location: `admin/${url.search}` });
            res.end();
            return;
        }
        if (req.method === 'GET' && url.pathname === '/favicon.ico') {
            res.writeHead(204);
            res.end();
            return;
        }
        const file = STATIC[url.pathname];
        if (req.method === 'GET' && file) {
            const data = fs.readFileSync(path.join(root, file[0], file[1]));
            res.writeHead(200, {
                'content-type': file[2],
                'cache-control': 'no-cache',
            });
            res.end(data);
            return;
        }

        if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/hook') {
            const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
            const token = bearer(req) || String(body.token || url.searchParams.get('token') || '');
            const hook = store.findHookByToken(token);
            if (!hook) {
                send(res, 401, { error: 'nao autorizado' });
                return;
            }
            const action = String(body.action || url.searchParams.get('action') || '');
            const actor = { id: null, displayName: hook.name, source: 'hook' };
            try {
                if (action === 'status') {
                    const status = enrich(await panel.getStatus());
                    const detail = !status.connected ? 'offline' : (status.fromCache ? 'cache' : 'painel');
                    store.recordCall({ source: 'hook', action: 'status', detail, ok: 1 });
                    send(res, 200, { ok: true, action, name: hook.name, ...status });
                    return;
                }
                let result;
                if (action === 'arm') result = await panel.arm(1, actor);
                else if (action === 'disarm') result = await panel.disarm(1, actor);
                else if (action === 'stay') result = await panel.armInhibited(1, store.stayZoneIds(), actor, 'stay');
                else throw fail('acao invalida. use arm, stay, disarm ou status', 400);
                store.recordCall({ source: 'hook', action, ok: 1 });
                send(res, 200, { ok: true, action, name: hook.name, ...finishAction(result, actor) });
            } catch (error) {
                store.recordCall({ source: 'hook', action: action || 'hook', detail: error.message, ok: 0 });
                send(res, error.statusCode || 500, { error: error.message });
            }
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/login') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const row = store.findUserByUsername(String(body.username || ''));
            if (!row || !verifyPassword(String(body.password || ''), row.password_hash)) {
                send(res, 401, { error: 'usuario ou senha invalido' });
                return;
            }
            if (body.device) store.touchDevice(row.id, String(body.device).slice(0, 80));
            send(res, 200, {
                token: store.createSession(row.id),
                user: store.findUserById(row.id),
            });
            return;
        }

        const user = userFrom(req);
        if (!user) {
            send(res, 401, { error: 'nao autorizado' });
            return;
        }
        const actor = { id: user.id, displayName: user.displayName, source: 'api' };

        if (req.method === 'POST' && url.pathname === '/api/logout') {
            store.deleteSession(bearer(req));
            send(res, 200, { ok: true });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/me') {
            send(res, 200, { user });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
            try {
                const status = enrich(await panel.getStatus());
                const detail = !status.connected ? 'offline' : (status.fromCache ? 'cache' : 'painel');
                store.recordCall({ userId: user.id, source: 'api', action: 'status', detail, ok: 1 });
                send(res, 200, status);
            } catch (error) {
                store.recordCall({
                    userId: user.id,
                    source: 'api',
                    action: 'status',
                    detail: error.message,
                    ok: 0,
                });
                send(res, error.statusCode || 500, { error: error.message });
            }
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/zones') {
            send(res, 200, { zones: store.listZones() });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/api/devices/push') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const name = String(body.name || 'android').slice(0, 80);
            const pushToken = body.token == null ? '' : String(body.token).slice(0, 512);
            store.touchDevice(user.id, name, pushToken);
            send(res, 200, { ok: true });
            return;
        }

        const partition = /^\/api\/partitions\/([1-4])\/(arm|disarm|stay|arm-inhibited)$/.exec(url.pathname);
        if (req.method === 'POST' && partition) {
            const id = Number(partition[1]);
            const action = partition[2];
            try {
                let result;
                if (action === 'arm') result = await panel.arm(id, actor);
                else if (action === 'disarm') result = await panel.disarm(id, actor);
                else if (action === 'stay') result = await panel.armInhibited(id, store.stayZoneIds(), actor, 'stay');
                else {
                    const body = JSON.parse((await readBody(req)) || '{}');
                    result = await panel.armInhibited(id, normalizeZones(body.zones), actor, 'arm');
                }
                store.recordCall({ userId: user.id, source: 'api', action, ok: 1 });
                send(res, 200, finishAction(result, actor));
            } catch (error) {
                store.recordCall({
                    userId: user.id,
                    source: 'api',
                    action,
                    detail: error.message,
                    ok: 0,
                });
                send(res, error.statusCode || 500, { error: error.message });
            }
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/zones/clear') {
            try {
                const result = await panel.clearZones(actor);
                store.recordCall({ userId: user.id, source: 'api', action: 'clear', ok: 1 });
                send(res, 200, finishAction(result, actor));
            } catch (error) {
                store.recordCall({ userId: user.id, source: 'api', action: 'clear', detail: error.message, ok: 0 });
                send(res, error.statusCode || 500, { error: error.message });
            }
            return;
        }

        if (!url.pathname.startsWith('/api/admin')) {
            send(res, 404, { error: 'nao encontrado' });
            return;
        }
        if (user.role !== 'admin') {
            send(res, 403, { error: 'sem permissao' });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/admin/hooks') {
            send(res, 200, { hooks: store.listHooks() });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/api/admin/hooks') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const name = String(body.name || '').trim().slice(0, 40);
            if (!name) throw fail('informe o nome', 400);
            send(res, 201, { hook: store.createHook(name) });
            return;
        }
        const hookMatch = /^\/api\/admin\/hooks\/(\d+)$/.exec(url.pathname);
        if (hookMatch && req.method === 'PATCH') {
            const current = store.findHook(Number(hookMatch[1]));
            if (!current) throw fail('token nao encontrado', 404);
            const body = JSON.parse((await readBody(req)) || '{}');
            const name = String(body.name || '').trim().slice(0, 40);
            if (!name) throw fail('informe o nome', 400);
            send(res, 200, { hook: store.updateHook(current.id, name) });
            return;
        }
        if (hookMatch && req.method === 'DELETE') {
            store.deleteHook(Number(hookMatch[1]));
            send(res, 200, { ok: true });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/admin/users') {
            send(res, 200, { users: store.listUsers() });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/api/admin/users') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const username = String(body.username || '').trim();
            const password = String(body.password || '');
            const role = body.role === 'admin' ? 'admin' : 'user';
            if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username)) throw fail('usuario invalido', 400);
            if (password.length < 4) throw fail('senha curta', 400);
            if (store.findUserByUsername(username)) throw fail('usuario ja existe', 400);
            const created = store.createUser({
                username,
                passwordHash: hashPassword(password),
                role,
                displayName: String(body.displayName || username).trim().slice(0, 40),
                telegramChatId: String(body.telegramChatId || '').trim(),
            });
            send(res, 201, { user: created });
            return;
        }

        const userMatch = /^\/api\/admin\/users\/(\d+)$/.exec(url.pathname);
        if (req.method === 'PATCH' && userMatch) {
            const id = Number(userMatch[1]);
            const current = store.findUserById(id);
            if (!current) throw fail('usuario nao encontrado', 404);
            const body = JSON.parse((await readBody(req)) || '{}');
            const fields = {};
            if (body.displayName != null) fields.displayName = String(body.displayName).trim().slice(0, 40);
            if (body.role != null) {
                if (!['user', 'admin'].includes(body.role)) throw fail('papel invalido', 400);
                if (current.role === 'admin' && body.role !== 'admin' && store.countAdmins() <= 1) {
                    throw fail('mantenha ao menos um admin', 400);
                }
                fields.role = body.role;
            }
            if (body.telegramChatId != null) fields.telegramChatId = String(body.telegramChatId).trim();
            if (body.password) {
                if (String(body.password).length < 4) throw fail('senha curta', 400);
                fields.passwordHash = hashPassword(String(body.password));
            }
            send(res, 200, { user: store.updateUser(id, fields) });
            return;
        }
        if (req.method === 'DELETE' && userMatch) {
            const id = Number(userMatch[1]);
            const current = store.findUserById(id);
            if (!current) throw fail('usuario nao encontrado', 404);
            if (current.id === user.id) throw fail('nao pode excluir a propria conta', 400);
            if (current.role === 'admin' && store.countAdmins() <= 1) {
                throw fail('mantenha ao menos um admin', 400);
            }
            store.deleteUser(id);
            send(res, 200, { ok: true });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/admin/zones') {
            send(res, 200, { zones: store.listZones() });
            return;
        }
        if (req.method === 'PUT' && url.pathname === '/api/admin/zones') {
            const body = JSON.parse((await readBody(req)) || '{}');
            send(res, 200, { zones: store.saveZones(body.zones || []) });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/panel-users') {
            send(res, 200, { users: store.listPanelUsers() });
            return;
        }
        if (req.method === 'PUT' && url.pathname === '/api/admin/panel-users') {
            const body = JSON.parse((await readBody(req)) || '{}');
            send(res, 200, { users: store.savePanelUsers(body.users || []) });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/settings') {
            send(res, 200, store.settings());
            return;
        }
        if (req.method === 'PUT' && url.pathname === '/api/admin/settings') {
            const body = JSON.parse((await readBody(req)) || '{}');
            if (body.clockIntervalMinutes != null) {
                const minutes = Number(body.clockIntervalMinutes);
                if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
                    throw fail('intervalo do relogio entre 5 e 1440 minutos', 400);
                }
                store.setSetting('clock_interval_minutes', minutes);
            }
            if (body.telegramBotToken != null) {
                store.setSetting('telegram_bot_token', String(body.telegramBotToken).trim());
            }
            if (body.firebaseServiceAccount != null) {
                const account = String(body.firebaseServiceAccount).trim();
                if (account) {
                    const parsed = JSON.parse(account);
                    if (!parsed.project_id || !parsed.private_key || !parsed.client_email) {
                        throw fail('JSON do Firebase incompleto', 400);
                    }
                }
                store.setSetting('firebase_service_account', account);
            }
            send(res, 200, store.settings());
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/schedules') {
            send(res, 200, { schedules: store.listSchedules() });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/api/admin/schedules') {
            const body = JSON.parse((await readBody(req)) || '{}');
            send(res, 201, { schedule: store.createSchedule(normalizeSchedule(body)) });
            return;
        }
        const scheduleMatch = /^\/api\/admin\/schedules\/(\d+)$/.exec(url.pathname);
        if (scheduleMatch && req.method === 'DELETE') {
            store.deleteSchedule(Number(scheduleMatch[1]));
            send(res, 200, { ok: true });
            return;
        }
        if (scheduleMatch && req.method === 'PATCH') {
            const current = store.findSchedule(Number(scheduleMatch[1]));
            if (!current) throw fail('programacao nao encontrada', 404);
            const body = JSON.parse((await readBody(req)) || '{}');
            const next = normalizeSchedule({ ...current, days: current.days, ...body });
            send(res, 200, {
                schedule: store.updateSchedule(current.id, { ...next, lastRun: current.lastRun, lastError: current.lastError }),
            });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/calls') {
            const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
            send(res, 200, { calls: store.listCalls(limit) });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/events') {
            const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
            send(res, 200, { events: store.listEvents(limit) });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/devices') {
            send(res, 200, { devices: store.listDevices() });
            return;
        }
        send(res, 404, { error: 'nao encontrado' });
    }

    const server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
            if (res.headersSent) return;
            const status = error instanceof SyntaxError ? 400 : (error.statusCode || 500);
            send(res, status, { error: error.message || 'erro interno' });
        });
    });

    return {
        enrich,
        listen(port, host) {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    server.off('error', reject);
                    resolve(server.address());
                });
            });
        },
        close() {
            return new Promise((resolve) => server.close(() => resolve()));
        },
    };
}

module.exports = { createApi };
