const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { newToken } = require('./auth');

function createStore(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
            display_name TEXT NOT NULL,
            telegram_chat_id TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            name TEXT NOT NULL,
            last_seen TEXT NOT NULL,
            UNIQUE (user_id, name)
        );
        CREATE TABLE IF NOT EXISTS zone_names (
            zone INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            stay INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS panel_user_names (
            code TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at TEXT NOT NULL,
            event_code TEXT NOT NULL,
            account_code TEXT,
            qualifier_code TEXT,
            zone_user TEXT,
            type TEXT,
            message TEXT,
            raw_hex TEXT,
            user_id INTEGER,
            actor_name TEXT
        );
        CREATE TABLE IF NOT EXISTS calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at TEXT NOT NULL,
            user_id INTEGER,
            source TEXT NOT NULL,
            action TEXT NOT NULL,
            detail TEXT,
            ok INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hooks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            token TEXT UNIQUE NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            action TEXT NOT NULL,
            time TEXT,
            days TEXT,
            run_once INTEGER NOT NULL DEFAULT 0,
            once_at TEXT,
            zones TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            last_run TEXT,
            last_error TEXT
        );
    `);

    const deviceColumns = db.prepare('PRAGMA table_info(devices)').all();
    if (!deviceColumns.some((column) => column.name === 'fcm_token')) {
        db.exec('ALTER TABLE devices ADD COLUMN fcm_token TEXT');
    }

    const zoneColumns = db.prepare('PRAGMA table_info(zone_names)').all();
    if (!zoneColumns.some((column) => column.name === 'panel_state')) {
        db.exec('ALTER TABLE zone_names ADD COLUMN panel_state TEXT');
    }

    const countZones = db.prepare('SELECT COUNT(*) AS n FROM zone_names').get();
    if (countZones.n === 0) {
        const insertZone = db.prepare('INSERT INTO zone_names (zone, name, stay) VALUES (?, ?, 0)');
        for (let zone = 1; zone <= 32; zone += 1) {
            insertZone.run(zone, `Zona ${zone}`);
        }
    }
    if (!db.prepare('SELECT value FROM settings WHERE key = ?').get('clock_interval_minutes')) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('clock_interval_minutes', '30');
    }

    function userRow(row) {
        if (!row) return null;
        return {
            id: row.id,
            username: row.username,
            role: row.role,
            displayName: row.display_name,
            telegramChatId: row.telegram_chat_id || '',
            createdAt: row.created_at,
        };
    }

    return {
        createUser({ username, passwordHash, role, displayName, telegramChatId }) {
            const info = db.prepare(`
                INSERT INTO users (username, password_hash, role, display_name, telegram_chat_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(
                username,
                passwordHash,
                role,
                displayName,
                telegramChatId || null,
                new Date().toISOString(),
            );
            return this.findUserById(Number(info.lastInsertRowid));
        },
        findUserByUsername(username) {
            return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
        },
        findUserById(id) {
            return userRow(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
        },
        listUsers() {
            return db.prepare('SELECT * FROM users ORDER BY id').all().map(userRow);
        },
        countAdmins() {
            return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
        },
        updateUser(id, fields) {
            const allowed = {
                displayName: 'display_name',
                role: 'role',
                telegramChatId: 'telegram_chat_id',
                passwordHash: 'password_hash',
            };
            const sets = [];
            const values = [];
            for (const [key, column] of Object.entries(allowed)) {
                if (fields[key] !== undefined) {
                    sets.push(`${column} = ?`);
                    values.push(fields[key] === '' ? null : fields[key]);
                }
            }
            if (sets.length === 0) return this.findUserById(id);
            values.push(id);
            db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
            return this.findUserById(id);
        },
        deleteUser(id) {
            db.exec('BEGIN');
            try {
                db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
                db.prepare('DELETE FROM devices WHERE user_id = ?').run(id);
                const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
                db.exec('COMMIT');
                return info.changes > 0;
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
        createSession(userId) {
            const token = newToken();
            db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
                .run(token, userId, new Date().toISOString());
            return token;
        },
        sessionUser(token) {
            const row = db.prepare(`
                SELECT users.* FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.token = ?
            `).get(token);
            return userRow(row);
        },
        deleteSession(token) {
            db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
        },
        createHook(name) {
            const token = newToken();
            const info = db.prepare('INSERT INTO hooks (name, token, created_at) VALUES (?, ?, ?)')
                .run(name, token, new Date().toISOString());
            return this.findHook(Number(info.lastInsertRowid));
        },
        findHook(id) {
            const row = db.prepare('SELECT * FROM hooks WHERE id = ?').get(id);
            return row ? hookRow(row) : null;
        },
        findHookByToken(token) {
            const row = db.prepare('SELECT * FROM hooks WHERE token = ?').get(token);
            return row ? hookRow(row) : null;
        },
        listHooks() {
            return db.prepare('SELECT * FROM hooks ORDER BY id').all().map(hookRow);
        },
        updateHook(id, name) {
            db.prepare('UPDATE hooks SET name = ? WHERE id = ?').run(name, id);
            return this.findHook(id);
        },
        deleteHook(id) {
            db.prepare('DELETE FROM hooks WHERE id = ?').run(id);
        },
        touchDevice(userId, name, fcmToken = undefined) {
            const now = new Date().toISOString();
            if (fcmToken === undefined) {
                db.prepare(`
                    INSERT INTO devices (user_id, name, last_seen) VALUES (?, ?, ?)
                    ON CONFLICT (user_id, name) DO UPDATE SET last_seen = excluded.last_seen
                `).run(userId, name, now);
                return;
            }
            db.prepare(`
                INSERT INTO devices (user_id, name, last_seen, fcm_token) VALUES (?, ?, ?, ?)
                ON CONFLICT (user_id, name) DO UPDATE SET
                    last_seen = excluded.last_seen,
                    fcm_token = excluded.fcm_token
            `).run(userId, name, now, fcmToken || null);
        },
        listDevices() {
            return db.prepare(`
                SELECT devices.id, devices.name, devices.last_seen, users.username, users.display_name,
                       CASE WHEN devices.fcm_token IS NOT NULL AND devices.fcm_token != '' THEN 1 ELSE 0 END AS push
                FROM devices JOIN users ON users.id = devices.user_id
                ORDER BY devices.last_seen DESC
            `).all();
        },
        listPushTokens() {
            return db.prepare(`
                SELECT fcm_token FROM devices
                WHERE fcm_token IS NOT NULL AND fcm_token != ''
            `).all().map((row) => row.fcm_token);
        },
        listZones() {
            return db.prepare('SELECT zone, name, stay, panel_state FROM zone_names ORDER BY zone').all()
                .filter((row) => row.panel_state !== 'disabled')
                .map((row) => ({
                    zone: row.zone,
                    name: row.name,
                    stay: row.stay === 1,
                    panelState: row.panel_state,
                }));
        },
        rememberZoneStates(zones) {
            const update = db.prepare(`
                UPDATE zone_names
                SET panel_state = ?, stay = CASE WHEN ? = 'disabled' THEN 0 ELSE stay END
                WHERE zone = ?
            `);
            for (const zone of zones) update.run(zone.state, zone.state, zone.id);
        },
        saveZones(zones) {
            const update = db.prepare('UPDATE zone_names SET name = ?, stay = ? WHERE zone = ?');
            for (const zone of zones) {
                const number = Number(zone.zone);
                if (!Number.isInteger(number) || number < 1 || number > 32) {
                    const error = new Error(`zona ${zone.zone} invalida`);
                    error.statusCode = 400;
                    throw error;
                }
                if (zone.stay && number > 8) {
                    const error = new Error(`zona ${number} nao entra na mascara de inibição`);
                    error.statusCode = 400;
                    throw error;
                }
                const name = String(zone.name || `Zona ${number}`).trim().slice(0, 40);
                update.run(name, zone.stay ? 1 : 0, number);
            }
            return this.listZones();
        },
        stayZoneIds() {
            return db.prepare(`
                SELECT zone FROM zone_names
                WHERE stay = 1 AND IFNULL(panel_state, '') != 'disabled'
                ORDER BY zone
            `).all().map((row) => row.zone);
        },
        zoneName(zone) {
            const row = db.prepare('SELECT name FROM zone_names WHERE zone = ?').get(Number(zone));
            return row ? row.name : `Zona ${zone}`;
        },
        listPanelUsers() {
            return db.prepare('SELECT code, name FROM panel_user_names ORDER BY code').all();
        },
        savePanelUsers(rows) {
            db.exec('DELETE FROM panel_user_names');
            const insert = db.prepare('INSERT INTO panel_user_names (code, name) VALUES (?, ?)');
            for (const row of rows) {
                const code = String(row.code || '').replace(/\D/g, '').padStart(3, '0').slice(-3);
                const name = String(row.name || '').trim().slice(0, 40);
                if (!name || code === '000') continue;
                insert.run(code, name);
            }
            return this.listPanelUsers();
        },
        panelUserName(code) {
            const normalized = String(code || '').replace(/\D/g, '').padStart(3, '0').slice(-3);
            const row = db.prepare('SELECT name FROM panel_user_names WHERE code = ?').get(normalized);
            return row ? row.name : normalized;
        },
        insertEvent(event) {
            db.prepare(`
                INSERT INTO events (
                    at, event_code, account_code, qualifier_code, zone_user, type, message, raw_hex, user_id, actor_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                event.at,
                event.event_code,
                event.account_code,
                event.qualifier_code,
                event.zone_user,
                event.type,
                event.message,
                event.raw_hex,
                event.user_id || null,
                event.actor_name || null,
            );
            db.prepare(`
                DELETE FROM events WHERE id NOT IN (
                    SELECT id FROM events ORDER BY id DESC LIMIT 1000
                )
            `).run();
        },
        countEvents() {
            return db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
        },
        listEvents(limit) {
            return db.prepare(`
                SELECT id, at, event_code, account_code, qualifier_code, zone_user, type, message, user_id, actor_name
                FROM events ORDER BY id DESC LIMIT ?
            `).all(limit);
        },
        recordCall({ userId = null, source, action, detail = null, ok = 1 }) {
            db.prepare(`
                INSERT INTO calls (at, user_id, source, action, detail, ok)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(new Date().toISOString(), userId, source, action, detail == null ? null : String(detail), ok ? 1 : 0);
        },
        listCalls(limit) {
            return db.prepare(`
                SELECT calls.id, calls.at, calls.source, calls.action, calls.detail, calls.ok,
                       users.username, users.display_name
                FROM calls LEFT JOIN users ON users.id = calls.user_id
                ORDER BY calls.id DESC LIMIT ?
            `).all(limit);
        },
        countPanelStatus() {
            return db.prepare("SELECT COUNT(*) AS n FROM calls WHERE source = 'panel' AND action = 'status'").get().n;
        },
        getSetting(key) {
            const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
            return row ? row.value : null;
        },
        setSetting(key, value) {
            db.prepare(`
                INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT (key) DO UPDATE SET value = excluded.value
            `).run(key, String(value));
        },
        settings() {
            const interval = Number(this.getSetting('clock_interval_minutes') || 30);
            const token = this.getSetting('telegram_bot_token') || '';
            const firebase = this.getSetting('firebase_service_account') || '';
            return {
                clockIntervalMinutes: interval,
                telegramConfigured: token.length > 0,
                firebaseConfigured: firebase.length > 0,
            };
        },
        listSchedules() {
            return db.prepare('SELECT * FROM schedules ORDER BY id').all().map(scheduleRow);
        },
        createSchedule(schedule) {
            const info = db.prepare(`
                INSERT INTO schedules (name, action, time, days, run_once, once_at, zones, enabled)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                schedule.name,
                schedule.action,
                schedule.time || null,
                schedule.days || null,
                schedule.runOnce ? 1 : 0,
                schedule.onceAt || null,
                schedule.zones || null,
                schedule.enabled === false ? 0 : 1,
            );
            return this.findSchedule(Number(info.lastInsertRowid));
        },
        findSchedule(id) {
            const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
            return row ? scheduleRow(row) : null;
        },
        updateSchedule(id, fields) {
            const current = this.findSchedule(id);
            if (!current) return null;
            const next = { ...current, ...fields };
            db.prepare(`
                UPDATE schedules
                SET name = ?, action = ?, time = ?, days = ?, run_once = ?, once_at = ?, zones = ?,
                    enabled = ?, last_run = ?, last_error = ?
                WHERE id = ?
            `).run(
                next.name,
                next.action,
                next.time || null,
                next.days || null,
                next.runOnce ? 1 : 0,
                next.onceAt || null,
                next.zones || null,
                next.enabled ? 1 : 0,
                next.lastRun || null,
                next.lastError || null,
                id,
            );
            return this.findSchedule(id);
        },
        deleteSchedule(id) {
            db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
        },
        telegramChats() {
            return db.prepare(`
                SELECT telegram_chat_id FROM users
                WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id != ''
            `).all().map((row) => row.telegram_chat_id);
        },
        close() {
            db.close();
        },
    };
}

function hookRow(row) {
    return {
        id: row.id,
        name: row.name,
        token: row.token,
        createdAt: row.created_at,
    };
}

function scheduleRow(row) {
    return {
        id: row.id,
        name: row.name,
        action: row.action,
        time: row.time || '',
        days: row.days || '',
        runOnce: row.run_once === 1,
        onceAt: row.once_at || '',
        zones: row.zones || '',
        enabled: row.enabled === 1,
        lastRun: row.last_run || '',
        lastError: row.last_error || '',
    };
}

module.exports = { createStore };
