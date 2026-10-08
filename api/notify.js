const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const https = require('https');

let cachedAccess = { token: '', exp: 0, projectId: '' };

function loadServiceAccount(store) {
    const file = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (file && fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    const stored = store.getSetting('firebase_service_account');
    if (!stored) return null;
    return JSON.parse(stored);
}

async function accessToken(account) {
    const now = Date.now();
    if (cachedAccess.token && cachedAccess.projectId === account.project_id && cachedAccess.exp > now + 60000) {
        return cachedAccess.token;
    }
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const issued = Math.floor(now / 1000);
    const claims = Buffer.from(JSON.stringify({
        iss: account.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: issued,
        exp: issued + 3600,
    })).toString('base64url');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${claims}`);
    sign.end();
    const assertion = `${header}.${claims}.${sign.sign(account.private_key).toString('base64url')}`;
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
        }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error_description || 'firebase recusou a credencial');
    cachedAccess = {
        token: body.access_token,
        exp: now + (Number(body.expires_in) * 1000),
        projectId: account.project_id,
    };
    return body.access_token;
}

let fcmHost = { address: '', exp: 0 };

async function fcmAddress() {
    const now = Date.now();
    if (fcmHost.address && fcmHost.exp > now) return fcmHost.address;
    const looked = await dns.lookup('fcm.googleapis.com', { all: true }).catch(() => []);
    const usable = looked.find((item) => item.address !== '0.0.0.0' && item.address !== '::');
    if (usable) {
        fcmHost = { address: '', exp: now + 300000 };
        return '';
    }
    const response = await fetch('https://dns.google/resolve?name=fcm.googleapis.com&type=A');
    const body = await response.json();
    const answer = (body.Answer || []).find((row) => row.type === 1 && row.data);
    if (!answer) throw new Error('nao foi possivel achar o endereco do Firebase');
    fcmHost = { address: answer.data, exp: now + 300000 };
    return answer.data;
}

function postFcm(path, headers, payload, address) {
    if (!address) {
        return fetch(`https://fcm.googleapis.com${path}`, {
            method: 'POST',
            headers,
            body: payload,
        }).then(async (response) => ({ ok: response.ok, status: response.status, body: await response.text() }));
    }
    return new Promise((resolve, reject) => {
        const request = https.request({
            host: address,
            servername: 'fcm.googleapis.com',
            path,
            method: 'POST',
            headers: { ...headers, host: 'fcm.googleapis.com', 'content-length': Buffer.byteLength(payload) },
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                resolve({
                    ok: response.statusCode >= 200 && response.statusCode < 300,
                    status: response.statusCode,
                    body: Buffer.concat(chunks).toString('utf8'),
                });
            });
        });
        request.on('error', reject);
        request.end(payload);
    });
}

async function sendFcm(store, text) {
    if (!text) return;
    const account = loadServiceAccount(store);
    if (!account?.project_id || !account.private_key || !account.client_email) return;
    const tokens = store.listPushTokens();
    if (tokens.length === 0) return;
    const access = await accessToken(account);
    const address = await fcmAddress();
    await Promise.all(tokens.map(async (token) => {
        const response = await postFcm(
            `/v1/projects/${account.project_id}/messages:send`,
            {
                authorization: `Bearer ${access}`,
                'content-type': 'application/json',
            },
            JSON.stringify({
                message: {
                    token,
                    notification: { title: 'Alarme', body: text },
                    data: { body: text },
                    android: {
                        priority: 'HIGH',
                        notification: { channel_id: 'alarme', sound: 'default' },
                    },
                },
            }),
            address,
        );
        if (!response.ok) {
            let detail = '';
            try {
                detail = JSON.parse(response.body)?.error?.message || '';
            } catch {
                detail = '';
            }
            console.error(`Firebase recusou o envio (${response.status}) ${detail}`.trim());
        }
    }));
}

async function sendTelegram(store, text) {
    const token = store.getSetting('telegram_bot_token');
    if (!token || !text) return;
    const chats = store.telegramChats();
    await Promise.all(chats.map(async (chatId) => {
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
        });
        if (!response.ok) {
            console.error(`Telegram recusou o envio (${response.status})`);
        }
    }));
}

function actionText(store, actor, action, zones) {
    const names = (zones || []).map((zone) => store.zoneName(zone)).join(', ');
    const who = actor?.source === 'schedule'
        ? `Agendamento ${actor.displayName}`
        : actor?.displayName || 'Sistema';
    if (action === 'disarm') return `${who} desarmou a central`;
    if (action === 'stay') {
        return names ? `${who} armou em stay, zonas inibidas: ${names}` : `${who} armou em stay`;
    }
    if (action === 'clear') return `${who} limpou as zonas inibidas`;
    if (names) return `${who} armou com zonas inibidas: ${names}`;
    return `${who} armou a central`;
}

function panelOrigin(eventCode) {
    const kind = String(eventCode || '').slice(-3);
    if (kind === '401') return 'pelo teclado';
    if (kind === '407') return 'pelo controle';
    if (kind === '409') return 'pela chave';
    if (kind === '441') return 'em stay';
    return '';
}

function eventText(store, event) {
    const zoneNumber = Number.parseInt(event.zone_user, 10);
    const zone = store.zoneName(zoneNumber);
    const person = store.panelUserName(event.zone_user);
    const origin = panelOrigin(event.event_code);
    switch (event.type) {
        case 'ARM':
            return origin ? `Central armada por ${person}, ${origin}` : `Central armada por ${person}`;
        case 'DISARM':
            return origin ? `Central desarmada por ${person}, ${origin}` : `Central desarmada por ${person}`;
        case 'ALARM_TRIGGER':
            return `Disparo na zona ${zone}`;
        case 'ALARM_RESTORE':
            return `Restauração na zona ${zone}`;
        case 'AC_FAULT':
            return 'Falha de energia';
        case 'AC_RESTORE':
            return 'Energia restaurada';
        case 'BYPASS':
            return `Zona inibida: ${zone}`;
        default:
            return event.message;
    }
}

module.exports = { sendTelegram, sendFcm, actionText, eventText };
