const loginView = document.querySelector('#login');
const adminView = document.querySelector('#admin');
const banner = document.querySelector('#banner');
let token = localStorage.getItem('jfl-token') || '';

const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function show(node, text) {
    node.hidden = !text;
    node.textContent = text || '';
}

function apiUrl(pathname) {
    const path = location.pathname;
    const root = /\/admin\/?$/.test(path)
        ? path.replace(/\/admin\/?$/, '')
        : path.replace(/\/$/, '');
    return `${root}${pathname}`;
}

async function api(pathname, options = {}) {
    const response = await fetch(apiUrl(pathname), {
        method: options.method || 'GET',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
        },
        body: options.body == null ? undefined : JSON.stringify(options.body),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
        logout();
        throw new Error('sessão encerrada');
    }
    if (!response.ok) throw new Error(body.error || 'falha na API');
    return body;
}

function logout() {
    const current = token;
    token = '';
    localStorage.removeItem('jfl-token');
    adminView.hidden = true;
    loginView.hidden = false;
    if (current) fetch(apiUrl('/api/logout'), { method: 'POST', headers: { authorization: `Bearer ${current}` } });
}

function field(form, name) {
    return form.elements[name];
}

async function load() {
    const [settings, hooks, users, zones, panelUsers, schedules, devices, events, calls] = await Promise.all([
        api('/api/admin/settings'),
        api('/api/admin/hooks'),
        api('/api/admin/users'),
        api('/api/admin/zones'),
        api('/api/admin/panel-users'),
        api('/api/admin/schedules'),
        api('/api/admin/devices'),
        api('/api/admin/events'),
        api('/api/admin/calls'),
    ]);
    field(document.querySelector('#settings-form'), 'clock').value = settings.clockIntervalMinutes;
    document.querySelector('#telegram-state').textContent = settings.telegramConfigured
        ? 'Bot configurado.'
        : 'Sem bot. Os eventos ficam só no banco.';
    document.querySelector('#firebase-state').textContent = settings.firebaseConfigured
        ? 'Firebase configurado. O app Android recebe push.'
        : 'Sem Firebase. O app funciona, mas não recebe push.';
    renderHooks(hooks.hooks);
    renderUsers(users.users);
    renderZones(zones.zones);
    renderScheduleZones(zones.zones.filter((zone) => zone.zone <= 8));
    renderPanelUsers(panelUsers.users);
    renderSchedules(schedules.schedules);
    renderTable('#devices', ['Usuário', 'Aparelho', 'Visto', 'Push'], devices.devices.map((device) => [
        device.display_name, device.name, device.last_seen, device.push ? 'sim' : 'não',
    ]));
    renderTable('#events', ['Quando', 'Código', 'Mensagem', 'Quem'], events.events.map((event) => [
        event.at, event.event_code, event.message, event.actor_name || '',
    ]));
    renderTable('#calls', ['Quando', 'Origem', 'Ação', 'Detalhe', 'Ok'], calls.calls.map((call) => [
        call.at, call.source, call.action, call.detail || '', call.ok ? 'sim' : 'não',
    ]));
}

function renderTable(selector, headers, rows) {
    const box = document.querySelector(selector);
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const header of headers) {
        const cell = document.createElement('th');
        cell.textContent = header;
        head.append(cell);
    }
    table.append(head);
    for (const row of rows) {
        const line = document.createElement('tr');
        for (const value of row) {
            const cell = document.createElement('td');
            cell.textContent = value == null ? '' : String(value);
            line.append(cell);
        }
        table.append(line);
    }
    if (rows.length === 0) {
        const line = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = headers.length;
        cell.textContent = 'Nada por aqui.';
        line.append(cell);
        table.append(line);
    }
    box.replaceChildren(table);
}

function renderHooks(hooks) {
    const box = document.querySelector('#hooks');
    box.replaceChildren();
    if (hooks.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = 'Nenhum token.';
        box.append(empty);
        return;
    }
    for (const hook of hooks) {
        const row = document.createElement('div');
        row.className = 'row';
        const form = document.createElement('form');
        form.className = 'row';
        const name = document.createElement('input');
        name.name = 'name';
        name.value = hook.name;
        name.setAttribute('aria-label', 'Nome');
        const token = document.createElement('code');
        token.textContent = hook.token;
        const save = document.createElement('button');
        save.type = 'submit';
        save.textContent = 'Salvar nome';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ghost';
        remove.textContent = 'Apagar';
        form.append(name, save);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            run(async () => {
                await api(`/api/admin/hooks/${hook.id}`, { method: 'PATCH', body: { name: name.value } });
                await load();
            });
        });
        remove.addEventListener('click', () => run(async () => {
            await api(`/api/admin/hooks/${hook.id}`, { method: 'DELETE' });
            await load();
        }));
        row.append(form, token, remove);
        box.append(row);
    }
}

function renderUsers(users) {
    const box = document.querySelector('#users');
    box.replaceChildren();
    for (const user of users) {
        const form = document.createElement('form');
        form.className = 'row';
        form.innerHTML = `
            <strong></strong>
            <input name="displayName" aria-label="Nome">
            <select name="role"><option value="user">user</option><option value="admin">admin</option></select>
            <input name="telegramChatId" placeholder="chat Telegram" aria-label="Chat">
            <input name="password" type="password" placeholder="nova senha" aria-label="Senha">
            <button type="submit">Salvar</button>`;
        form.querySelector('strong').textContent = user.username;
        form.elements.displayName.value = user.displayName;
        form.elements.role.value = user.role;
        form.elements.telegramChatId.value = user.telegramChatId || '';
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            await run(async () => {
                await api(`/api/admin/users/${user.id}`, {
                    method: 'PATCH',
                    body: {
                        displayName: form.elements.displayName.value,
                        role: form.elements.role.value,
                        telegramChatId: form.elements.telegramChatId.value,
                        password: form.elements.password.value,
                    },
                });
                form.elements.password.value = '';
                await load();
            });
        });
        box.append(form);
    }
}

function renderZones(zones) {
    const box = document.querySelector('#zones');
    box.replaceChildren();
    for (const zone of zones) {
        const row = document.createElement('div');
        row.className = 'row';
        const name = document.createElement('input');
        name.value = zone.name;
        name.dataset.zone = String(zone.zone);
        name.setAttribute('aria-label', `Zona ${zone.zone}`);
        const stayLabel = document.createElement('label');
        stayLabel.className = 'check';
        const stay = document.createElement('input');
        stay.type = 'checkbox';
        stay.checked = zone.stay;
        stay.disabled = zone.zone > 8;
        stay.dataset.stay = String(zone.zone);
        stayLabel.append(stay, document.createTextNode('stay'));
        const title = document.createElement('strong');
        title.textContent = String(zone.zone);
        row.append(title, name, stayLabel);
        box.append(row);
    }
}

function panelUserRow(user = { code: '', name: '' }) {
    const row = document.createElement('div');
    row.className = 'row';
    const code = document.createElement('input');
    code.name = 'code';
    code.value = user.code;
    code.placeholder = '099';
    code.maxLength = 3;
    const name = document.createElement('input');
    name.name = 'name';
    name.value = user.name;
    name.placeholder = 'Nome';
    row.append(code, name);
    return row;
}

function renderPanelUsers(users) {
    const box = document.querySelector('#panel-users');
    box.replaceChildren();
    for (const user of users) box.append(panelUserRow(user));
    if (users.length === 0) box.append(panelUserRow());
}

function renderSchedules(schedules) {
    const box = document.querySelector('#schedules');
    box.replaceChildren();
    for (const schedule of schedules) {
        const row = document.createElement('div');
        row.className = 'row';
        const text = document.createElement('span');
        const when = schedule.runOnce ? schedule.onceAt : `${schedule.days} ${schedule.time}`;
        text.textContent = `${schedule.name}: ${schedule.action} ${when}${schedule.zones ? ` zonas ${schedule.zones}` : ''}${schedule.enabled ? '' : ' (desligada)'}${schedule.lastError ? ` — ${schedule.lastError}` : ''}`;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'ghost';
        toggle.textContent = schedule.enabled ? 'Desligar' : 'Ligar';
        toggle.addEventListener('click', () => run(() => saveSchedule(schedule, !schedule.enabled)));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ghost';
        remove.textContent = 'Apagar';
        remove.addEventListener('click', () => run(async () => {
            await api(`/api/admin/schedules/${schedule.id}`, { method: 'DELETE' });
            await load();
        }));
        row.append(text, toggle, remove);
        box.append(row);
    }
}

async function saveSchedule(schedule, enabled) {
    const days = schedule.runOnce ? [] : String(schedule.days || '').split(',').filter(Boolean).map(Number);
    const zones = String(schedule.zones || '').split(',').filter(Boolean).map(Number);
    await api(`/api/admin/schedules/${schedule.id}`, {
        method: 'PATCH',
        body: { ...schedule, enabled, days, zones },
    });
    await load();
}

async function run(task) {
    show(banner, '');
    try {
        await task();
    } catch (error) {
        show(banner, error.message);
    }
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    show(document.querySelector('#login-error'), '');
    try {
        const response = await fetch(apiUrl('/api/login'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                username: data.get('username'),
                password: data.get('password'),
                device: 'admin',
            }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'não entrou');
        if (body.user.role !== 'admin') throw new Error('sem permissão');
        token = body.token;
        localStorage.setItem('jfl-token', token);
        loginView.hidden = true;
        adminView.hidden = false;
        await load();
    } catch (error) {
        show(document.querySelector('#login-error'), error.message);
    }
});

document.querySelector('#logout').addEventListener('click', logout);

document.querySelector('#settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    run(async () => {
        const body = { clockIntervalMinutes: Number(form.elements.clock.value) };
        if (form.elements.token.value) body.telegramBotToken = form.elements.token.value;
        if (form.elements.firebase.value) body.firebaseServiceAccount = form.elements.firebase.value;
        await api('/api/admin/settings', { method: 'PUT', body });
        form.elements.token.value = '';
        form.elements.firebase.value = '';
        await load();
    });
});

document.querySelector('#clear-token').addEventListener('click', () => run(async () => {
    await api('/api/admin/settings', { method: 'PUT', body: { telegramBotToken: '' } });
    await load();
}));

document.querySelector('#clear-firebase').addEventListener('click', () => run(async () => {
    await api('/api/admin/settings', { method: 'PUT', body: { firebaseServiceAccount: '' } });
    await load();
}));

document.querySelector('#hook-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    run(async () => {
        await api('/api/admin/hooks', { method: 'POST', body: { name: form.elements.name.value } });
        form.reset();
        await load();
    });
});

document.querySelector('#user-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    run(async () => {
        await api('/api/admin/users', {
            method: 'POST',
            body: {
                username: form.elements.username.value,
                password: form.elements.password.value,
                displayName: form.elements.displayName.value,
                role: form.elements.role.value,
                telegramChatId: form.elements.telegramChatId.value,
            },
        });
        form.reset();
        await load();
    });
});

document.querySelector('#zones-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
        const zones = [...document.querySelectorAll('#zones input[data-zone]')].map((input) => ({
            zone: Number(input.dataset.zone),
            name: input.value,
            stay: document.querySelector(`#zones input[data-stay="${input.dataset.zone}"]`).checked,
        }));
        await api('/api/admin/zones', { method: 'PUT', body: { zones } });
        await load();
    });
});

document.querySelector('#add-panel-user').addEventListener('click', () => {
    document.querySelector('#panel-users').append(panelUserRow());
});

document.querySelector('#panel-users-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
        const users = [...document.querySelectorAll('#panel-users .row')].map((row) => ({
            code: row.querySelector('[name=code]').value,
            name: row.querySelector('[name=name]').value,
        }));
        await api('/api/admin/panel-users', { method: 'PUT', body: { users } });
        await load();
    });
});

const days = document.querySelector('#days');
for (let day = 0; day < 7; day += 1) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(day);
    input.checked = day >= 1 && day <= 5;
    label.append(input, document.createTextNode(DAY_NAMES[day]));
    days.append(label);
}
const scheduleZones = document.querySelector('#schedule-zones');

function renderScheduleZones(zones) {
    const checked = new Set(
        [...scheduleZones.querySelectorAll('input:checked')].map((input) => input.value),
    );
    scheduleZones.replaceChildren();
    for (const zone of zones) {
        const label = document.createElement('label');
        label.className = 'check';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = String(zone.zone);
        input.checked = checked.has(input.value);
        label.append(input, document.createTextNode(zone.name || String(zone.zone)));
        scheduleZones.append(label);
    }
}

document.querySelector('#schedule-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    run(async () => {
        await api('/api/admin/schedules', {
            method: 'POST',
            body: {
                name: form.elements.name.value,
                action: form.elements.action.value,
                runOnce: form.elements.runOnce.checked,
                time: form.elements.time.value,
                onceAt: form.elements.onceAt.value,
                days: [...days.querySelectorAll('input:checked')].map((input) => Number(input.value)),
                zones: [...scheduleZones.querySelectorAll('input:checked')].map((input) => Number(input.value)),
            },
        });
        form.elements.name.value = '';
        await load();
    });
});

async function boot() {
    if (!token) return;
    try {
        const me = await api('/api/me');
        if (me.user.role !== 'admin') {
            show(document.querySelector('#login-error'), 'sem permissão');
            return;
        }
        loginView.hidden = true;
        adminView.hidden = false;
        await load();
    } catch (error) {
        show(document.querySelector('#login-error'), error.message);
    }
}

boot();
