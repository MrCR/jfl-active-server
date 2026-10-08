const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { start } = require('../api/server');
const { hashPassword } = require('../api/auth');
const { connectFake, contactId, statusCommands } = require('./fake-panel');

async function boot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfl-'));
    const notes = [];
    const app = await start({
        panelHost: '127.0.0.1',
        panelPort: 0,
        apiHost: '127.0.0.1',
        apiPort: 0,
        dataFile: path.join(dir, 'jfl.sqlite'),
        mqttBroker: null,
        jobs: false,
        commandTimeoutMs: 1000,
        notify: async (text) => {
            notes.push(text);
        },
    });
    app.notes = notes;
    app.base = `http://127.0.0.1:${app.apiPort}`;
    return app;
}

function user(app, username, role, displayName) {
    return app.store.createUser({
        username,
        passwordHash: hashPassword('1234'),
        role,
        displayName,
    });
}

async function login(app, username) {
    const response = await fetch(`${app.base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: '1234', device: 'teste' }),
    });
    const body = await response.json();
    return { status: response.status, ...body };
}

function authed(token) {
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function api(app, token, method, pathname, payload) {
    const response = await fetch(`${app.base}${pathname}`, {
        method,
        headers: authed(token),
        body: payload == null ? undefined : JSON.stringify(payload),
    });
    const body = await response.json();
    return { status: response.status, body };
}

test('sem app aberto a central não recebe status', async () => {
    const app = await boot();
    try {
        const fake = await connectFake(app.panelPort);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(statusCommands(fake.received).length, 0);
        assert.equal(app.store.countPanelStatus(), 0);
        fake.socket.end();
    } finally {
        await app.close();
    }
});

test('dois status simultâneos viram um quadro e o seguinte usa o cache', async () => {
    const app = await boot();
    try {
        user(app, 'ana', 'admin', 'Ana');
        const session = await login(app, 'ana');
        const fake = await connectFake(app.panelPort, { holdStatus: true });
        const first = api(app, session.token, 'GET', '/api/status');
        const second = api(app, session.token, 'GET', '/api/status');
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(statusCommands(fake.received).length, 1);
        fake.release();
        const [left, right] = await Promise.all([first, second]);
        assert.equal(left.status, 200);
        assert.equal(right.body.batteryVolts, 13.3);
        assert.equal(left.body.fromCache, false);
        assert.equal(statusCommands(fake.received).length, 1);
        assert.equal(app.store.countPanelStatus(), 1);

        const cached = await api(app, session.token, 'GET', '/api/status');
        assert.equal(cached.body.fromCache, true);
        assert.equal(statusCommands(fake.received).length, 1);
        fake.socket.end();
    } finally {
        await app.close();
    }
});

test('arme com zona inibida, desarme e evento atribuído ao usuário', async () => {
    const app = await boot();
    try {
        const ana = user(app, 'ana', 'admin', 'Ana');
        const session = await login(app, 'ana');
        app.store.savePanelUsers([{ code: '001', name: 'Teclado' }]);
        const fake = await connectFake(app.panelPort, { emitRemoteArm: true });

        const armed = await api(app, session.token, 'POST', '/api/partitions/1/arm-inhibited', { zones: [7] });
        assert.equal(armed.status, 200);
        assert.equal(armed.body.partitions[0].state, 'armed');
        assert.equal(armed.body.zones.find((zone) => zone.id === 7).state, 'inhibited');
        const inhibit = fake.received.find((frame) => frame[1] === 0x36 && frame[2] === 0x05);
        assert.equal(inhibit[3], 0x40);
        assert.equal(app.notes.length, 1);
        assert.match(app.notes[0], /Ana armou com zonas inibidas/);

        const events = await api(app, session.token, 'GET', '/api/admin/events');
        assert.equal(events.body.events[0].user_id, ana.id);
        assert.equal(events.body.events[0].actor_name, 'Ana');
        assert.equal(events.body.events[0].event_code, '3407');

        const disarmed = await api(app, session.token, 'POST', '/api/partitions/1/disarm');
        assert.equal(disarmed.body.mode, 'disarmed');
        assert.equal(disarmed.body.zones.find((zone) => zone.id === 7).state, 'closed');

        app.store.saveZones([{ zone: 7, name: 'Varanda', stay: true }]);
        const stay = await api(app, session.token, 'POST', '/api/partitions/1/stay');
        assert.equal(stay.body.zones.find((zone) => zone.id === 7).state, 'inhibited');
        assert.match(app.notes.at(-1), /Ana armou em stay, zonas inibidas: Varanda/);

        fake.send(contactId('3401', '001'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        const keypad = await api(app, session.token, 'GET', '/api/admin/events');
        const typed = keypad.body.events.find((event) => event.event_code === '3401');
        assert.equal(typed.user_id, null);
        assert.match(typed.message, /Teclado/);
        assert.ok(app.notes.some((note) => note.includes('Teclado')));
        fake.socket.end();
    } finally {
        await app.close();
    }
});

test('token fixo arma em nome da automação e teclado ou controle continuam avisando', async () => {
    const app = await boot();
    try {
        user(app, 'ana', 'admin', 'Ana');
        const session = await login(app, 'ana');
        const created = await api(app, session.token, 'POST', '/api/admin/hooks', { name: 'Casa' });
        assert.equal(created.status, 201);
        const hook = created.body.hook.token;
        const fake = await connectFake(app.panelPort, { emitRemoteArm: true });

        const armed = await fetch(`${app.base}/api/hook`, {
            method: 'POST',
            headers: { authorization: `Bearer ${hook}`, 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'arm' }),
        });
        const armedBody = await armed.json();
        assert.equal(armed.status, 200);
        assert.equal(armedBody.ok, true);
        assert.equal(armedBody.action, 'arm');
        assert.equal(armedBody.name, 'Casa');
        assert.equal(armedBody.mode, 'armed');
        assert.match(app.notes.at(-1), /Casa armou a central/);

        const logged = await api(app, session.token, 'GET', '/api/admin/events');
        assert.equal(logged.body.events[0].actor_name, 'Casa');
        assert.equal(logged.body.events[0].user_id, null);

        const notes = app.notes.length;
        fake.send(contactId('1570', '007'));
        fake.send(contactId('3401', '001'));
        fake.send(contactId('1407', '003'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(app.notes.length, notes + 2);
        assert.ok(app.notes.some((note) => note.includes('pelo teclado')));
        assert.ok(app.notes.some((note) => note.includes('pelo controle')));

        const denied = await api(app, hook, 'GET', '/api/admin/events');
        assert.equal(denied.status, 401);
        const bad = await fetch(`${app.base}/api/hook`, {
            method: 'POST',
            headers: { authorization: `Bearer ${hook}`, 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'explodir' }),
        });
        const badBody = await bad.json();
        assert.equal(bad.status, 400);
        assert.match(badBody.error, /acao invalida/);
        const status = await fetch(`${app.base}/api/hook?action=status`, {
            headers: { authorization: `Bearer ${hook}` },
        });
        const statusBody = await status.json();
        assert.equal(status.status, 200);
        assert.equal(statusBody.ok, true);
        assert.equal(statusBody.action, 'status');
        fake.socket.end();
    } finally {
        await app.close();
    }
});

test('usuário comum não entra no admin e a central desconectada recusa comando', async () => {
    const app = await boot();
    try {
        user(app, 'bob', 'user', 'Bob');
        const session = await login(app, 'bob');
        const denied = await api(app, session.token, 'GET', '/api/admin/events');
        assert.equal(denied.status, 403);
        const offline = await api(app, session.token, 'GET', '/api/status');
        assert.equal(offline.body.connected, false);
        assert.equal(app.store.countPanelStatus(), 0);
        const arm = await api(app, session.token, 'POST', '/api/partitions/1/arm');
        assert.equal(arm.status, 503);
        const missing = await login(app, 'ninguem');
        assert.equal(missing.status, 401);
    } finally {
        await app.close();
    }
});

test('token de push fica no aparelho e sem Firebase não envia', async () => {
    const app = await boot();
    try {
        user(app, 'bob', 'user', 'Bob');
        const session = await login(app, 'bob');
        const saved = await api(app, session.token, 'POST', '/api/devices/push', {
            token: 'fcm-1',
            name: 'android',
        });
        assert.equal(saved.status, 200);
        assert.deepEqual(app.store.listPushTokens(), ['fcm-1']);
        const { sendFcm } = require('../api/notify');
        await sendFcm(app.store, 'Disparo na zona Sala');
        const cleared = await api(app, session.token, 'POST', '/api/devices/push', {
            token: '',
            name: 'android',
        });
        assert.equal(cleared.status, 200);
        assert.deepEqual(app.store.listPushTokens(), []);
    } finally {
        await app.close();
    }
});

test('limpador fica com os 1000 eventos mais novos', async () => {
    const app = await boot();
    try {
        for (let index = 1; index <= 1005; index += 1) {
            app.store.insertEvent({
                at: new Date().toISOString(),
                event_code: '1130',
                account_code: '0001',
                qualifier_code: '01',
                zone_user: String(index).padStart(3, '0'),
                type: 'ALARM_TRIGGER',
                message: `evento ${index}`,
                raw_hex: '',
            });
        }
        assert.equal(app.store.countEvents(), 1000);
        const newest = app.store.listEvents(1)[0];
        assert.equal(newest.message, 'evento 1005');
        const oldest = app.store.listEvents(1000).at(-1);
        assert.equal(oldest.message, 'evento 6');
    } finally {
        await app.close();
    }
});

test('agendamento de uma vez arma e não repete', async () => {
    const app = await boot();
    try {
        user(app, 'ana', 'admin', 'Ana');
        const session = await login(app, 'ana');
        const fake = await connectFake(app.panelPort);
        const created = await api(app, session.token, 'POST', '/api/admin/schedules', {
            name: 'Noite',
            action: 'arm',
            runOnce: true,
            onceAt: new Date(Date.now() - 5000).toISOString(),
            zones: [7],
        });
        assert.equal(created.status, 201);
        await app.jobs.runSchedules(new Date());
        await app.jobs.runSchedules(new Date());
        const arms = fake.received.filter((frame) => frame[1] === 0x36 && frame[2] === 0x01);
        assert.equal(arms.length, 1);
        const inhibits = fake.received.filter((frame) => frame[1] === 0x36 && frame[2] === 0x05);
        assert.equal(inhibits.length, 1);
        assert.equal(inhibits[0][3], 0x40);
        const schedule = app.store.listSchedules()[0];
        assert.equal(schedule.enabled, false);
        assert.match(app.notes.at(-1), /Agendamento Noite/);
        fake.socket.end();
    } finally {
        await app.close();
    }
});

test('relógio só é enviado de novo depois do intervalo', async () => {
    const app = await boot();
    try {
        const fake = await connectFake(app.panelPort);
        await app.jobs.runClock(new Date());
        await app.jobs.runClock(new Date());
        const clocks = fake.received.filter((frame) => frame[1] === 0xca);
        assert.equal(clocks.length, 1);
        assert.equal(clocks[0].length, 28);
        fake.socket.end();
    } finally {
        await app.close();
    }
});

test('agendamento com a central fora registra falha uma vez', async () => {
    const app = await boot();
    try {
        app.store.createSchedule({
            name: 'Manha',
            action: 'disarm',
            runOnce: true,
            onceAt: new Date(Date.now() - 1000).toISOString(),
        });
        await app.jobs.runSchedules(new Date());
        await app.jobs.runSchedules(new Date());
        const schedule = app.store.listSchedules()[0];
        assert.equal(schedule.enabled, false);
        assert.match(schedule.lastError, /desconectada/);
        const jobs = app.store.listCalls(10).filter((call) => call.source === 'job');
        assert.equal(jobs.length, 1);
    } finally {
        await app.close();
    }
});

test('CLI cria usuário que consegue entrar', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfl-'));
    const dataFile = path.join(dir, 'jfl.sqlite');
    const result = spawnSync(process.execPath, [
        'api/bin/create-user.js',
        '--username', 'cli',
        '--password', '1234',
        '--role', 'admin',
        '--name', 'Pelo CLI',
    ], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DATA_FILE: dataFile },
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const app = await start({
        panelHost: '127.0.0.1',
        panelPort: 0,
        apiHost: '127.0.0.1',
        apiPort: 0,
        dataFile,
        mqttBroker: null,
        jobs: false,
        notify: async () => {},
    });
    app.base = `http://127.0.0.1:${app.apiPort}`;
    try {
        const session = await login(app, 'cli');
        assert.equal(session.status, 200);
        assert.equal(session.user.displayName, 'Pelo CLI');
        assert.equal(session.user.role, 'admin');
        const page = await fetch(`http://127.0.0.1:${app.apiPort}/`);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /Alarme/);
    } finally {
        await app.close();
    }
});
