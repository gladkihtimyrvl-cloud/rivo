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
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, display_name TEXT,
        six_digit_id TEXT UNIQUE, password TEXT, status TEXT DEFAULT 'online', 
        bio TEXT DEFAULT 'Привет, я использую Rivo!', avatar TEXT DEFAULT '', coins INTEGER DEFAULT 100
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, creator TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS group_members (group_id INTEGER, username TEXT, PRIMARY KEY (group_id, username))`);
    // ДОБАВИЛИ КОЛОНКУ comment В ТАБЛИЦУ СООБЩЕНИЙ
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, 
        text TEXT, isGift INTEGER, comment TEXT, timestamp TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS received_gifts (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, gift_emoji TEXT, comment TEXT, timestamp TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS promocodes (code TEXT UNIQUE, reward INTEGER, max_uses INTEGER, current_uses INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS blocks (blocker TEXT, blocked TEXT, PRIMARY KEY (blocker, blocked))`);
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
                        else {
                            ws.send(JSON.stringify({ type: 'auth_success' }));
                            broadcastAllUsers();
                        }
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
                        db.get(`SELECT * FROM users WHERE username = ?`, [ws.username], (e, updatedUser) => {
                            ws.send(JSON.stringify({ type: 'profile_saved', user: updatedUser }));
                        });
                    });
                });
            }

            if (data.type === 'admin_give_coins') {
                if (ws.username !== 'revezzz') return ws.send(JSON.stringify({ type: 'error', message: 'У вас нет прав!' }));
                db.run(`UPDATE users SET coins = coins + ? WHERE username = ?`, [data.amount, data.target], () => {
                    db.get(`SELECT coins FROM users WHERE username = ?`, [data.target], (e, r) => {
                        ws.send(JSON.stringify({ type: 'admin_success', message: `Начислено ${data.amount} R пользователю ${data.target}` }));
                        const recipientSocket = clients.get(data.target);
                        if (recipientSocket) recipientSocket.send(JSON.stringify({ type: 'update_coins', coins: r.coins }));
                        if (data.target === ws.username) ws.send(JSON.stringify({ type: 'update_coins', coins: r.coins }));
                    });
                });
            }

            if (data.type === 'get_chat_list') {
                db.all(`SELECT DISTINCT CASE WHEN sender = ? THEN receiver ELSE sender END as contact FROM messages WHERE (sender = ? OR receiver = ?) AND receiver NOT LIKE 'group_%'`, 
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
                db.get(`SELECT * FROM blocks WHERE blocker = ? AND blocked = ?`, [data.to, ws.username], (err, block) => {
                    if (block) return ws.send(JSON.stringify({ type: 'error', message: 'Вы заблокированы этим пользователем.' }));
                    const time = new Date().toLocaleTimeString();
                    db.run(`INSERT INTO messages (sender, receiver, text, isGift, timestamp) VALUES (?, ?, ?, 0, ?)`, [data.from, data.to, data.text, time]);
                    const recipientSocket = clients.get(data.to);
                    if (recipientSocket) recipientSocket.send(JSON.stringify({ type: 'private', from: data.from, text: data.text, isGift: false, time: time }));
                });
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
                db.get(`SELECT username, display_name, six_digit_id, status, bio, avatar, coins FROM users WHERE username = ?`, [data.target], (err, user) => {
                    db.get(`SELECT * FROM blocks WHERE blocker = ? AND blocked = ?`, [ws.username, data.target], (e, iBlocked) => {
                        db.all(`SELECT * FROM received_gifts WHERE receiver = ? ORDER BY id DESC`, [data.target], (err, gifts) => {
                            ws.send(JSON.stringify({ type: 'profile_data', user: user, gifts: gifts, iBlocked: !!iBlocked }));
                        });
                    });
                });
            }

            if (data.type === 'get_groups') {
                db.all(`SELECT g.id, g.name FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.username = ?`, [ws.username], (err, rows) => {
                    ws.send(JSON.stringify({ type: 'my_groups', groups: rows }));
                });
            }
            
            // ИСПРАВЛЕНО: СОХРАНЯЕМ КОММЕНТАРИЙ В БАЗУ
            if (data.type === 'private' && data.isGift) {
                db.get(`SELECT coins FROM users WHERE username = ?`, [ws.username], (err, row) => {
                    if (row.coins < data.giftPrice) return ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно R-коинов!' }));
                    db.get(`SELECT * FROM blocks WHERE blocker = ? AND blocked = ?`, [data.to, ws.username], (err, block) => {
                        if (block) return ws.send(JSON.stringify({ type: 'error', message: 'Вы заблокированы этим пользователем.' }));
                        db.run(`UPDATE users SET coins = coins - ? WHERE username = ?`, [data.giftPrice, ws.username], () => {
                            const time = new Date().toLocaleTimeString();
                            const comment = data.comment || "";
                            
                            // ДОБАВИЛИ comment
                            db.run(`INSERT INTO messages (sender, receiver, text, isGift, comment, timestamp) VALUES (?, ?, ?, 1, ?, ?)`, [data.from, data.to, data.text, comment, time]);
                            db.run(`INSERT INTO received_gifts (sender, receiver, gift_emoji, comment, timestamp) VALUES (?, ?, ?, ?, ?)`, [data.from, data.to, data.text, comment, time]);
                            
                            const recipientSocket = clients.get(data.to);
                            if (recipientSocket) recipientSocket.send(JSON.stringify({ type: 'private', from: data.from, text: data.text, isGift: true, comment: comment, time: time }));
                            ws.send(JSON.stringify({ type: 'update_coins', coins: row.coins - data.giftPrice }));
                        });
                    });
                });
            }

            if (data.type === 'block_user') {
                db.run(`INSERT OR IGNORE INTO blocks (blocker, blocked) VALUES (?, ?)`, [ws.username, data.target], () => {
                    ws.send(JSON.stringify({ type: 'action_success', action: 'block', target: data.target }));
                });
            }
            if (data.type === 'unblock_user') {
                db.run(`DELETE FROM blocks WHERE blocker = ? AND blocked = ?`, [ws.username, data.target], () => {
                    ws.send(JSON.stringify({ type: 'action_success', action: 'unblock', target: data.target }));
                });
            }

            if (data.type === 'delete_chat') {
                db.run(`DELETE FROM messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)`, 
                [ws.username, data.target, data.target, ws.username], () => {
                    ws.send(JSON.stringify({ type: 'chat_deleted', target: data.target }));
                });
            }

            if (data.type === 'create_promo') {
                if (ws.username !== 'revezzz') return ws.send(JSON.stringify({ type: 'promo_result', success: false, message: 'У вас нет прав!' }));
                const code = data.code.toUpperCase();
                db.run(`INSERT INTO promocodes (code, reward, max_uses) VALUES (?, ?, ?)`, [code, data.reward, data.max_uses], function(err) {
                    if (err) ws.send(JSON.stringify({ type: 'promo_result', success: false, message: 'Промокод уже существует!' }));
                    else ws.send(JSON.stringify({ type: 'promo_result', success: true, message: `Промокод ${code} создан!` }));
                });
            }

            if (data.type === 'redeem_promo') {
                const code = data.code.toUpperCase();
                db.get(`SELECT * FROM promocodes WHERE code = ?`, [code], (err, row) => {
                    if (err || !row) return ws.send(JSON.stringify({ type: 'promo_result', success: false, message: 'Промокод не найден!' }));
                    if (row.current_uses >= row.max_uses) return ws.send(JSON.stringify({ type: 'promo_result', success: false, message: 'Лимит исчерпан!' }));
                    db.run(`UPDATE promocodes SET current_uses = current_uses + 1 WHERE code = ?`, [code]);
                    db.run(`UPDATE users SET coins = coins + ? WHERE username = ?`, [row.reward, ws.username], () => {
                        db.get(`SELECT coins FROM users WHERE username = ?`, [ws.username], (e, r) => {
                            ws.send(JSON.stringify({ type: 'promo_result', success: true, message: `+${row.reward} R-коинов!`, newBalance: r.coins }));
                            broadcastAllUsers();
                        });
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
