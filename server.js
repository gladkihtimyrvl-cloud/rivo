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
        avatar TEXT DEFAULT '👤', 
        coins INTEGER DEFAULT 100
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, 
        text TEXT, isGift INTEGER, timestamp TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS promocodes (
        code TEXT UNIQUE, reward INTEGER, max_uses INTEGER, current_uses INTEGER DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS received_gifts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, 
        gift_emoji TEXT, comment TEXT, timestamp TEXT
    )`);
});

const clients = new Map(); 

wss.on('connection', function connection(ws) {
    ws.on('message', function incoming(message) {
        try {
            const data = JSON.parse(message);

            if (data.type === 'register') {
                const cleanUsername = data.username.trim(); 
                const hash = bcrypt.hashSync(data.password, 10);
                
                // Генерируем уникальный 6-значный ID
                let newId;
                let isUnique = false;
                while (!isUnique) {
                    newId = Math.floor(100000 + Math.random() * 900000).toString();
                    // В реальном проекте тут нужна проверка по БД, но для простоты оставим так
                    isUnique = true; 
                }

                db.run(`INSERT INTO users (username, display_name, six_digit_id, password) VALUES (?, ?, ?, ?)`, 
                [cleanUsername, cleanUsername, newId, hash], function(err) {
                    if (err) ws.send(JSON.stringify({ type: 'auth_error', message: 'Этот юзернейм уже занят!' }));
                    else {
                        ws.send(JSON.stringify({ type: 'auth_success' }));
                        broadcastOnlineUsers(); 
                    }
                });
            }

            if (data.type === 'login') {
                const cleanUsername = data.username.trim();
                db.get(`SELECT * FROM users WHERE username = ?`, [cleanUsername], (err, row) => {
                    if (err || !row) ws.send(JSON.stringify({ type: 'auth_error', message: 'Пользователь не найден!' }));
                    else if (bcrypt.compareSync(data.password, row.password)) {
                        clients.set(cleanUsername, ws);
                        ws.username = cleanUsername;
                        ws.send(JSON.stringify({ 
                            type: 'auth_success', bio: row.bio, status: row.status, 
                            avatar: row.avatar, coins: row.coins, display_name: row.display_name, six_digit_id: row.six_digit_id
                        }));
                        broadcastOnlineUsers();
                    } else ws.send(JSON.stringify({ type: 'auth_error', message: 'Неверный пароль!' }));
                });
            }

            if (data.type === 'update_profile') {
                // Проверяем, не занят ли новый 6-значный ID
                db.get(`SELECT username FROM users WHERE six_digit_id = ? AND username != ?`, [data.six_digit_id, ws.username], (err, row) => {
                    if (row) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Этот 6-значный ID уже занят!' }));
                    } else {
                        db.run(`UPDATE users SET status = ?, bio = ?, avatar = ?, display_name = ?, six_digit_id = ? WHERE username = ?`, 
                        [data.status, data.bio, data.avatar, data.display_name, data.six_digit_id, ws.username], () => {
                            broadcastOnlineUsers();
                            // Отправляем обновленные данные клиенту
                            db.get(`SELECT display_name, six_digit_id FROM users WHERE username = ?`, [ws.username], (e, r) => {
                                ws.send(JSON.stringify({ type: 'profile_updated', display_name: r.display_name, six_digit_id: r.six_digit_id }));
                            });
                        });
                    }
                });
            }

            if (data.type === 'create_promo') {
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
                            broadcastOnlineUsers();
                        });
                    });
                });
            }

            if (data.type === 'private' && data.isGift) {
                const giftPrice = data.giftPrice;
                db.get(`SELECT coins FROM users WHERE username = ?`, [ws.username], (err, row) => {
                    if (row.coins < giftPrice) return ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно R-коинов!' }));
                    
                    db.run(`UPDATE users SET coins = coins - ? WHERE username = ?`, [giftPrice, ws.username], () => {
                        const time = new Date().toLocaleTimeString();
                        const comment = data.comment || "";
                        db.run(`INSERT INTO messages (sender, receiver, text, isGift, timestamp) VALUES (?, ?, ?, 1, ?)`, [data.from, data.to, data.text, time]);
                        db.run(`INSERT INTO received_gifts (sender, receiver, gift_emoji, comment, timestamp) VALUES (?, ?, ?, ?, ?)`, [data.from, data.to, data.text, comment, time]);
                        
                        const recipientSocket = clients.get(data.to);
                        if (recipientSocket) {
                            recipientSocket.send(JSON.stringify({ type: 'private', from: data.from, text: data.text, isGift: true, comment: comment, time: time }));
                        }
                        
                        db.get(`SELECT coins FROM users WHERE username = ?`, [ws.username], (e, r) => {
                            ws.send(JSON.stringify({ type: 'update_coins', coins: r.coins }));
                        });
                    });
                });
                return;
            }

            if (data.type === 'private' && !data.isGift) {
                const time = new Date().toLocaleTimeString();
                db.run(`INSERT INTO messages (sender, receiver, text, isGift, timestamp) VALUES (?, ?, ?, 0, ?)`, [data.from, data.to, data.text, time]);
                const recipientSocket = clients.get(data.to);
                if (recipientSocket) recipientSocket.send(JSON.stringify({ type: 'private', from: data.from, text: data.text, isGift: false, time: time }));
            }

            if (data.type === 'get_history') {
                db.all(`SELECT * FROM messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) ORDER BY id ASC`, [ws.username, data.with, data.with, ws.username], (err, rows) => {
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
        } catch (e) { console.log(e); }
    });

    ws.on('close', function() {
        if (ws.username) {
            db.run(`UPDATE users SET status = 'offline' WHERE username = ?`, [ws.username]);
            clients.delete(ws.username);
            broadcastOnlineUsers();
        }
    });
});

function broadcastOnlineUsers() {
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