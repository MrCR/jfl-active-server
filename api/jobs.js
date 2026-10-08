function pad(value) {
    return String(value).padStart(2, '0');
}

function slotOf(date, time) {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${time}`;
}

function dueSchedule(schedule, now) {
    if (!schedule.enabled) return null;
    if (schedule.runOnce) {
        if (schedule.lastRun) return null;
        if (!schedule.onceAt) return null;
        return now.getTime() >= new Date(schedule.onceAt).getTime() ? schedule.onceAt : null;
    }
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    if (schedule.time !== time) return null;
    const days = String(schedule.days || '').split(',').map((day) => Number(day)).filter((day) => !Number.isNaN(day));
    if (!days.includes(now.getDay())) return null;
    const slot = slotOf(now, time);
    if (schedule.lastRun === slot) return null;
    return slot;
}

function zoneList(value) {
    if (!value) return [];
    return String(value).split(',').map((zone) => Number(zone)).filter((zone) => Number.isInteger(zone) && zone > 0);
}

function createJobs({ store, panel, perform }) {
    return {
        async runClock(now = new Date()) {
            const interval = Number(store.getSetting('clock_interval_minutes') || 30);
            const last = store.getSetting('last_clock_at');
            if (last && now.getTime() - new Date(last).getTime() < interval * 60000) return;
            if (!panel.connected()) return;
            try {
                await panel.setClock(now, { source: 'job', displayName: 'relógio' });
                store.setSetting('last_clock_at', now.toISOString());
                store.recordCall({ source: 'job', action: 'clock', ok: 1 });
            } catch (error) {
                store.setSetting('last_clock_at', now.toISOString());
                store.recordCall({ source: 'job', action: 'clock', detail: error.message, ok: 0 });
            }
        },
        async runSchedules(now = new Date()) {
            for (const schedule of store.listSchedules()) {
                const slot = dueSchedule(schedule, now);
                if (!slot) continue;
                const actor = { source: 'schedule', displayName: schedule.name };
                if (!panel.connected()) {
                    store.updateSchedule(schedule.id, {
                        lastRun: slot,
                        lastError: 'central desconectada',
                        enabled: schedule.runOnce ? false : schedule.enabled,
                    });
                    store.recordCall({
                        source: 'job',
                        action: schedule.action,
                        detail: `${schedule.name}: central desconectada`,
                        ok: 0,
                    });
                    continue;
                }
                try {
                    await perform(schedule, actor);
                    store.updateSchedule(schedule.id, {
                        lastRun: slot,
                        lastError: '',
                        enabled: schedule.runOnce ? false : schedule.enabled,
                    });
                    store.recordCall({ source: 'job', action: schedule.action, detail: schedule.name, ok: 1 });
                } catch (error) {
                    store.updateSchedule(schedule.id, {
                        lastRun: slot,
                        lastError: error.message,
                        enabled: schedule.runOnce ? false : schedule.enabled,
                    });
                    store.recordCall({
                        source: 'job',
                        action: schedule.action,
                        detail: `${schedule.name}: ${error.message}`,
                        ok: 0,
                    });
                }
            }
        },
        zoneList,
    };
}

module.exports = { createJobs, dueSchedule, zoneList };
