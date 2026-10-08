const crypto = require('crypto');

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 32).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
    const [kind, salt, hash] = String(stored || '').split('$');
    if (kind !== 'scrypt' || !salt || !hash) return false;
    const next = crypto.scryptSync(password, salt, 32);
    const previous = Buffer.from(hash, 'hex');
    if (next.length !== previous.length) return false;
    return crypto.timingSafeEqual(next, previous);
}

function newToken() {
    return crypto.randomBytes(32).toString('hex');
}

module.exports = { hashPassword, verifyPassword, newToken };
