const path = require('path');
const { createStore } = require('../db');
const { hashPassword } = require('../auth');

function arg(name) {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) return null;
    return process.argv[index + 1] || null;
}

function usage() {
    console.error('uso: node api/bin/create-user.js --username NOME --password SENHA [--role admin|user] [--name "Nome"]');
    process.exit(1);
}

const username = arg('username');
const password = arg('password');
const role = arg('role') || 'user';
const displayName = arg('name') || username;

if (!username || !password) usage();
if (!['user', 'admin'].includes(role)) usage();
if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username)) {
    console.error('usuario invalido');
    process.exit(1);
}
if (password.length < 4) {
    console.error('senha curta');
    process.exit(1);
}

const dataFile = process.env.DATA_FILE || path.join(process.cwd(), 'data', 'jfl.sqlite');
const store = createStore(dataFile);
if (store.findUserByUsername(username)) {
    console.error('usuario ja existe');
    store.close();
    process.exit(1);
}
const user = store.createUser({
    username,
    passwordHash: hashPassword(password),
    role,
    displayName: displayName.trim().slice(0, 40),
});
store.close();
console.log(`usuario ${user.username} criado (${user.role})`);
