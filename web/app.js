const loginView = document.querySelector('#login');
const panelView = document.querySelector('#panel');
const loginForm = document.querySelector('#login-form');
const loginError = document.querySelector('#login-error');
const modeTitle = document.querySelector('#mode');
const meta = document.querySelector('#meta');
const banner = document.querySelector('#banner');
const actions = document.querySelector('#actions');
const zonesBox = document.querySelector('#zones');
const adminLink = document.querySelector('#admin-link');

const MODE = {
    disarmed: 'Desarmada',
    armed: 'Armada',
    stay: 'Armada stay',
    alarm: 'Disparada',
    unknown: 'Sem leitura',
};

let token = localStorage.getItem('jfl-token') || '';
let role = '';
let status = null;
let selected = new Set();
let busy = false;
let timer = null;

function showError(node, text) {
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

async function request(pathname, options = {}) {
    const response = await fetch(apiUrl(pathname), {
        method: options.method || 'GET',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
        },
        body: options.body == null ? undefined : JSON.stringify(options.body),
    });
    const body = await response.json();
    if (response.status === 401) {
        logout();
        throw new Error('sessão encerrada');
    }
    if (!response.ok) throw new Error(body.error || 'falha na API');
    return body;
}

function stopPoll() {
    clearInterval(timer);
    timer = null;
}

function startPoll() {
    stopPoll();
    if (!token || document.visibilityState !== 'visible') return;
    pull();
    timer = setInterval(() => {
        if (document.visibilityState === 'visible') pull();
    }, 10000);
}

async function pull() {
    try {
        status = await request('/api/status');
        showError(banner, '');
        render();
    } catch (error) {
        showError(banner, error.message);
    }
}

function logout() {
    const current = token;
    token = '';
    role = '';
    localStorage.removeItem('jfl-token');
    stopPoll();
    panelView.hidden = true;
    loginView.hidden = false;
    if (current) {
        fetch(apiUrl('/api/logout'), { method: 'POST', headers: { authorization: `Bearer ${current}` } });
    }
}

function render() {
    const mode = status?.mode || 'unknown';
    modeTitle.textContent = status?.connected ? MODE[mode] || MODE.unknown : 'Central desconectada';
    const bits = [];
    if (status?.batteryVolts != null) bits.push(`Bateria ${String(status.batteryVolts).replace('.', ',')} V`);
    if (status?.trouble?.ac) bits.push('Falha de rede');
    if (status?.trouble?.battery) bits.push('Falha de bateria');
    if (status?.clock) {
        const clock = status.clock;
        const pad = (value) => String(value).padStart(2, '0');
        bits.push(`${pad(clock.hour)}:${pad(clock.minute)}:${pad(clock.second)}`);
    }
    if (status?.updatedAt && !status.connected) bits.push('última leitura guardada');
    meta.textContent = bits.join(' · ');

    const canAct = Boolean(status?.connected) && !busy;
    const disarmed = mode === 'disarmed';
    const reading = status?.zones || [];
    const zones = reading.filter((zone) => zone.state !== 'disabled');
    for (const id of [...selected]) {
        if (reading.length > 0 && !zones.some((zone) => zone.id === id)) selected.delete(id);
    }
    actions.replaceChildren();
    if (disarmed && canAct) {
        actions.append(commandButton('Armar', 'arm', () => command('/api/partitions/1/arm')));
        actions.append(commandButton('Arme stay', 'stay', () => command('/api/partitions/1/stay')));
    }
    if ((mode === 'armed' || mode === 'stay' || mode === 'alarm') && canAct) {
        actions.append(commandButton('Desarmar', 'disarm', () => command('/api/partitions/1/disarm')));
    }
    if (disarmed && canAct && selected.size > 0) {
        const button = commandButton('Armar com zonas inibidas', 'inhibit', () => command('/api/partitions/1/arm-inhibited', {
            zones: [...selected],
        }));
        button.classList.add('wide');
        actions.append(button);
    }

    zonesBox.replaceChildren();
    if (reading.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = 'Aguardando a central.';
        zonesBox.append(empty);
        return;
    }
    for (const zone of zones) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'zone';
        if (zone.state === 'inhibited') button.classList.add('inhibited');
        if (zone.state === 'open') button.classList.add('open');
        if (zone.state === 'alarm') button.classList.add('alarm');
        if (selected.has(zone.id)) button.classList.add('selected');
        button.disabled = !disarmed || !canAct;
        const name = document.createElement('strong');
        name.textContent = zone.name || `Zona ${zone.id}`;
        const caption = document.createElement('small');
        caption.textContent = zone.label || '';
        button.append(name, caption);
        button.addEventListener('click', () => {
            if (selected.has(zone.id)) selected.delete(zone.id);
            else selected.add(zone.id);
            render();
        });
        zonesBox.append(button);
    }
}

function commandButton(label, kind, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = kind;
    button.textContent = label;
    button.disabled = busy;
    button.addEventListener('click', onClick);
    return button;
}

async function command(pathname, body) {
    busy = true;
    render();
    try {
        status = await request(pathname, { method: 'POST', body: body || {} });
        selected.clear();
        showError(banner, '');
    } catch (error) {
        showError(banner, error.message);
    } finally {
        busy = false;
        render();
    }
}

loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(loginForm);
    showError(loginError, '');
    try {
        const response = await fetch(apiUrl('/api/login'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                username: data.get('username'),
                password: data.get('password'),
                device: 'web',
            }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'não entrou');
        token = body.token;
        role = body.user.role;
        localStorage.setItem('jfl-token', token);
        loginView.hidden = true;
        panelView.hidden = false;
        adminLink.hidden = role !== 'admin';
        startPoll();
    } catch (error) {
        showError(loginError, error.message);
    }
});

document.querySelector('#logout').addEventListener('click', logout);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startPoll();
    else stopPoll();
});

async function boot() {
    if (!token) return;
    try {
        const me = await request('/api/me');
        role = me.user.role;
        loginView.hidden = true;
        panelView.hidden = false;
        adminLink.hidden = role !== 'admin';
        startPoll();
    } catch {
        logout();
    }
}

boot();
