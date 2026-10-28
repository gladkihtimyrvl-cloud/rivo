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
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, 
        text TEXT, isGift INTEGER, comment TEXT, timestamp TEXT
    )`);
    
    // ТАБЛИЦА ДЛЯ NFT
    db.run(`CREATE TABLE IF NOT EXISTS nfts (
        id TEXT PRIMARY KEY,
        owner TEXT,
        base_type TEXT,
        rarity TEXT,
        color TEXT,
        pattern TEXT,
        num INTEGER,
        is_listed INTEGER DEFAULT 0,
        price INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS promocodes (code TEXT UNIQUE, reward INTEGER, max_uses INTEGER, current_uses INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS blocks (blocker TEXT, blocked TEXT, PRIMARY KEY (blocker, blocked))`);
    db.run(`CREATE TABLE IF NOT EXISTS promo_history (username TEXT, code TEXT, PRIMARY KEY (username, code))`);
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

            // УЛУЧШЕНИЕ ДО ПОДАРКА В NFT (РУЛЕТКА)
            if (data.type === 'upgrade_to_nft') {
                const cost = data.cost;
                db.get(`SELECT coins FROM users WHERE username = ?`, [ws.username], (err, row) => {
                    if (row.coins < cost) return ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно R-коинов для улучшения!' }));
                    
                    // Списываем коины
                    db.run(`UPDATE users SET coins = coins - ? WHERE username = ?`, [cost, ws.username], () => {
                        // Генерируем случайные параметры NFT
                        const rarities = ['Common', 'Rare', 'Epic', 'Legendary'];
                        const colors = ['#FF5252', '#448AFF', '#69F0AE', '#FFD740', '#E040FB', '#00E5FF'];
                        const patterns = ['None', 'Stripes', 'Dots', 'Galaxy'];
                        
                        const randomRarity = rarities[Math.floor(Math.random() * rarities.length)];
                        const randomColor = colors[Math.floor(Math.random() * colors.length)];
                        const randomPattern = patterns[Math.floor(Math.random() * patterns.length)];
                        const nftId = 'nft_' + Date.now() + Math.floor(Math.random()*1000);
                        const nftNum = Math.floor(1 + Math.random() * 999);

                        db.run(`INSERT INTO nfts (id, owner, base_type, rarity, color, pattern, num) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [nftId, ws.username, data.base_type, randomRarity, randomColor, randomPattern, nftNum], () => {
                            db.get(`SELECT coins FROM users WHERE username = ?`, [ws.username], (e, r) => {
                                ws.send(JSON.stringify({ 
                                    type: 'nft_upgraded', 
                                    nft: { id: nftId, base_type: data.base_type, rarity: randomRarity, color: randomColor, pattern: randomPattern, num: nftNum },
                                    newBalance: r.coins 
                                }));
                            });
                        });
                    });
                });
            }

            // ПОЛУЧИТЬ NFT ПОЛЬЗОВАТЕЛЯ
            if (data.type === 'get_nfts') {
                db.all(`SELECT * FROM nfts WHERE owner = ?`, [data.target], (err, rows) => {
                    ws.send(JSON.stringify({ type: 'user_nfts', nfts: rows }));
                });
            }

            // ВЫСТАВИТЬ НА МАРКЕТПЛЕЙС
            if (data.type === 'list_nft') {
                db.run(`UPDATE nfts SET is_listed = 1, price = ? WHERE id = ? AND owner = ?`, [data.price, data.nft_id, ws.username], () => {
                    ws.send(JSON.stringify({ type: 'nft_listed', success: true }));
                    broadcastMarketplace();
                });
            }

            // КУПИТЬ NFT С МАРКЕТПЛЕЙСА
            if (data.type === 'buy_nft') {
                db.get(`SELECT * FROM nfts WHERE id = ? AND is_listed = 1`, [data.nft_id], (err, nft) => {
                    if (!nft) return ws.send(JSON.stringify({ type: 'error', message: 'NFT уже продан или снят с продажи.' }));
                    if (nft.owner === ws.username) return ws.send(JSON.stringify({ type: 'error', message: 'Вы не можете купить свой NFT.' }));

                    db.get(`SELECT coins FROM users WHERE username = ?`, [ws.username], (e, buyer) => {
                        if (buyer.coins < nft.price) return ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно R-коинов!' }));

                        // Снимаем деньги у покупателя, начисляем продавцу
                        db.run(`UPDATE users SET coins = coins - ? WHERE username = ?`, [nft.price, ws.username]);
                        db.run(`UPDATE users SET coins = coins + ? WHERE username = ?`, [nft.price, nft.owner]);
                        
                        // Меняем владельца
                        db.run(`UPDATE nfts SET owner = ?, is_listed = 0, price = 0 WHERE id = ?`, [ws.username, data.nft_id], () => {
                            ws.send(JSON.stringify({ type: 'nft_bought', success: true }));
                            const sellerSocket = clients.get(nft.owner);
                            if(sellerSocket) sellerSocket.send(JSON.stringify({ type: 'update_coins', coins: nft.price + buyer.coins })); // Приблизительно
                            broadcastMarketplace();
                        });
                    });
                });
            }

            // ПОЛУЧИТЬ МАРКЕТПЛЕЙС
            if (data.type === 'get_marketplace') {
                db.all(`SELECT * FROM nfts WHERE is_listed = 1`, [], (err, rows) => {
                    ws.send(JSON.stringify({ type: 'marketplace_data', items: rows }));
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
                if (data.with.startsWith('group_')) {
                    db.all(`SELECT * FROM messages WHERE receiver = ? ORDER BY id ASC`, [data.with], (err, rows) => {
                        if (!err) ws.send(JSON.stringify({ type: 'history', with: data.with, messages: rows }));
                    });
                } else {
                    db.all(`SELECT * FROM messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) ORDER BY id ASC`, 
                    [ws.username, data.with, data.with, ws.username], (err, rows) => {
                        if (!err) ws.send(JSON.stringify({ type: 'history', with: data.with, messages: rows }));
                    });
                }
            }
            
            // СТАРЫЕ ПОДАРКИ (ТЕПЕРЬ БЕЗ ХРАНЕНИЯ В ПРОФИЛЕ, ТОЛЬКО В ЧАТЕ)
            if (data.type === 'private' && data.isGift) {
                db.get(`SELECT coins FROM users WHERE username = ?`, [ws.username], (err, row) => {
                    if (row.coins < data.giftPrice) return ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно R-коинов!' }));
                    db.run(`UPDATE users SET coins = coins - ? WHERE username = ?`, [data.giftPrice, ws.username], () => {
                        const time = new Date().toLocaleTimeString();
                        db.run(`INSERT INTO messages (sender, receiver, text, isGift, comment, timestamp) VALUES (?, ?, ?, 1, ?, ?)`, [data.from, data.to, data.text, data.comment, time]);
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

function broadcastMarketplace() {
    db.all(`SELECT * FROM nfts WHERE is_listed = 1`, [], (err, rows) => {
        if (!err) {
            const message = JSON.stringify({ type: 'marketplace_data', items: rows });
            clients.forEach((socket) => {
                if (socket.readyState === WebSocket.OPEN) socket.send(message);
            });
        }
    });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Rivo Server запущен на порту ${PORT}`));
