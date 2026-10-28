const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.static(__dirname));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const db = new sqlite3.Database('./database.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT UNIQUE, 
        display_name TEXT,
        six_digit_id TEXT UNIQUE, 
        password TEXT,
        status TEXT DEFAULT 'online', 
        bio TEXT DEFAULT 'Привет, я использую Rivo!',
        avatar TEXT DEFAULT '', 
        coins INTEGER DEFAULT 100
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, creator TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS group_members (group_id INTEGER, username TEXT, PRIMARY KEY (group_id, username))`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, text TEXT, isGift INTEGER, timestamp TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS received_gifts (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, gift_emoji TEXT, comment TEXT, timestamp TEXT)`);
});

const clients = new Map(); 

wss.on('connection', function connection(ws) {
    ws.on('message', function incoming(message) {
        try {
            const data = JSON.parse(message);

            if (data.type === 'register') {
                const cleanUsername = data.username.trim(); 
                db.get(`SELECT username FROM users WHERE username = ?`, [cleanUsername], (err, row) => {
                    if (row) return ws.send(JSON.stringify({ type: 'auth_error', message: 'Этот юзернейм уже занят!' }));
                    let uniqueId = Math.floor(100000 + Math.random() * 900000).toString();
                    const hash = bcrypt.hashSync(data.password, 10);
                    db.run(`INSERT INTO users (username, display_name, six_digit_id, password) VALUES (?, ?, ?, ?)`, 
                    [cleanUsername, cleanUsername, uniqueId, hash], function(err) {
                        if (err) ws.send(JSON.stringify({ type: 'auth_error', message: 'Ошибка сервера.' }));
                        else ws.send(JSON.stringify({ type: 'auth_success' }));
                    });
                });
            }

            if (data.type === 'login') {
                const cleanUsername = data.username.trim();
                db.get(`SELECT * FROM users WHERE username = ?`, [cleanUsername], (err, row) => {
                    if (err || !row) ws.send(JSON.stringify({ type: 'auth_error', message: 'Пользователь не найден!' }));
                    else if (bcrypt.compareSync(data.password, row.password)) {
                        if (clients.has(cleanUsername)) {
                            const oldWs = clients.get(cleanUsername);
                            if (oldWs && oldWs.readyState === WebSocket.OPEN) {
                                oldWs.send(JSON.stringify({ type: 'force_logout', message: 'Вход с другого устройства.' }));
                                oldWs.close();
                            }
                        }
                        clients.set(cleanUsername, ws);
                        ws.username = cleanUsername;
                        ws.send(JSON.stringify({ type: 'auth_success', user: row }));
                        broadcastAllUsers(); 
                    } else ws.send(JSON.stringify({ type: 'auth_error', message: 'Неверный пароль!' }));
                });
            }

            if (data.type === 'update_profile') {
                db.get(`SELECT username FROM users WHERE six_digit_id = ? AND username != ?`, [data.six_digit_id, ws.username], (err, row) => {
                    if (row) return ws.send(JSON.stringify({ type: 'error', message: 'Этот 6-значный ID уже занят!' }));
                    db.run(`UPDATE users SET status = ?, bio = ?, avatar = ?, display_name = ?, six_digit_id = ? WHERE username = ?`, 
                    [data.status, data.bio, data.avatar, data.display_name, data.six_digit_id, ws.username], () => {
                        broadcastAllUsers();
                        db.get(`SELECT display_name, six_digit_id FROM users WHERE username = ?`, [ws.username], (e, r) => {
                            ws.send(JSON.stringify({ type: 'profile_updated', display_name: r.display_name, six_digit_id: r.six_digit_id }));
                        });
                    });
                });
            }

            // ПОЛУЧИТЬ СПИСОК ЛИЧНЫХ ЧАТОВ (ТЕХ, С КЕМ ЕСТЬ ИСТОРИЯ)
            if (data.type === 'get_chat_list') {
                db.all(`SELECT DISTINCT CASE WHEN sender = ? THEN receiver ELSE sender END as contact 
                        FROM messages 
                        WHERE (sender = ? OR receiver = ?) AND receiver NOT LIKE 'group_%'`, 
                [ws.username, ws.username, ws.username], (err, rows) => {
                    if (!err) {
                        const contacts = rows.map(r => r.contact);
                        ws.send(JSON.stringify({ type: 'chat_list', contacts: contacts }));
                    }
                });
            }

            if (data.type === 'create_group') {
                db.run(`INSERT INTO groups (name, creator) VALUES (?, ?)`, [data.name, ws.username], function(err) {
                    const groupId = this.lastID;
                    db.run(`INSERT INTO group_members (group_id, username) VALUES (?, ?)`, [groupId, ws.username]);
                    data.members.forEach(m => db.run(`INSERT INTO group_members (group_id, username) VALUES (?, ?)`, [groupId, m]));
                    ws.send(JSON.stringify({ type: 'group_created', groupId: groupId, name: data.name }));
                });
            }

            if (data.type === 'private' && !data.isGift) {
                const time = new Date().toLocaleTimeString();
                db.run(`INSERT INTO messages (sender, receiver, text, isGift, timestamp) VALUES (?, ?, ?, 0, ?)`, [data.from, data.to, data.text, time]);
                const recipientSocket = clients.get(data.to);
                if (recipientSocket) recipientSocket.send(JSON.stringify({ type: 'private', from: data.from, text: data.text, isGift: false, time: time }));
            }

            if (data.type === 'group_message') {
                const time = new Date().toLocaleTimeString();
                const receiver = 'group_' + data.groupId;
                db.run(`INSERT INTO messages (sender, receiver, text, isGift, timestamp) VALUES (?, ?, ?, 0, ?)`, [data.from, receiver, data.text, time]);
                db.all(`SELECT username FROM group_members WHERE group_id = ?`, [data.groupId], (err, rows) => {
                    rows.forEach(r => {
                        const socket = clients.get(r.username);
                        if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'group_message', from: data.from, groupId: data.groupId, text: data.text, time: time }));
                    });
                });
            }

            if (data.type === 'get_history') {
                db.all(`SELECT * FROM messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) ORDER BY id ASC`, 
                [ws.username, data.with, data.with, ws.username], (err, rows) => {
                    if (!err) ws.send(JSON.stringify({ type: 'history', with: data.with, messages: rows }));
                });
            }
            
            if (data.type === 'get_profile') {
                db.get(`SELECT username, display_name, six_digit_id, status, bio, avatar FROM users WHERE username = ?`, [data.target], (err, user) => {
                    db.all(`SELECT * FROM received_gifts WHERE receiver = ? ORDER BY id DESC`, [data.target], (err, gifts) => {
                        ws.send(JSON.stringify({ type: 'profile_data', user: user, gifts: gifts }));
                    });
                });
            }

            if (data.type === 'get_groups') {
                db.all(`SELECT g.id, g.name FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.username = ?`, [ws.username], (err, rows) => {
                    ws.send(JSON.stringify({ type: 'my_groups', groups: rows }));
                });
            }
            
            if (data.type === 'private' && data.isGift) {
                db.get(`SELECT coins FROM users WHERE username = ?`, [ws.username], (err, row) => {
                    if (row.coins < data.giftPrice) return ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно R-коинов!' }));
                    db.run(`UPDATE users SET coins = coins - ? WHERE username = ?`, [data.giftPrice, ws.username], () => {
                        const time = new Date().toLocaleTimeString();
                        db.run(`INSERT INTO messages (sender, receiver, text, isGift, timestamp) VALUES (?, ?, ?, 1, ?)`, [data.from, data.to, data.text, time]);
                        db.run(`INSERT INTO received_gifts (sender, receiver, gift_emoji, comment, timestamp) VALUES (?, ?, ?, ?, ?)`, [data.from, data.to, data.text, data.comment, time]);
                        const recipientSocket = clients.get(data.to);
                        if (recipientSocket) recipientSocket.send(JSON.stringify({ type: 'private', from: data.from, text: data.text, isGift: true, comment: data.comment, time: time }));
                        ws.send(JSON.stringify({ type: 'update_coins', coins: row.coins - data.giftPrice }));
                    });
                });
            }
        } catch (e) { console.log(e); }
    });

    ws.on('close', function() {
        if (ws.username) {
            db.run(`UPDATE users SET status = 'offline' WHERE username = ?`, [ws.username]);
            clients.delete(ws.username);
            broadcastAllUsers();
        }
    });
});

function broadcastAllUsers() {
    db.all(`SELECT username, display_name, six_digit_id, status, bio, avatar FROM users`, [], (err, rows) => {
        if (!err) {
            const message = JSON.stringify({ type: 'user_list', users: rows });
            clients.forEach((socket) => {
                if (socket.readyState === WebSocket.OPEN) socket.send(message);
            });
        }
    });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Rivo Server запущен на порту ${PORT}`));
