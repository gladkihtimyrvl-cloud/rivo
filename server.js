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

// КАТАЛОГ ПОДАРКОВ
const GIFT_CATALOG = {
    'gift_rose': { name: 'Роза', price: 100, rarity: 'Common', max_supply: 10000 },
    'gift_bear': { name: 'Плюшевый Мишка', price: 1000, rarity: 'Uncommon', max_supply: 5000 },
    'gift_diamond': { name: 'Алмаз', price: 5000, rarity: 'Rare', max_supply: 1000 },
    'gift_crown': { name: 'Золотая Корона', price: 25000, rarity: 'Epic', max_supply: 100 },
    'gift_pepe': { name: 'Plush Pepe', price: 100000, rarity: 'Legendary', max_supply: 10 }
};

// ХАРАКТЕРИСТИКИ ДЛЯ ГЕНЕРАЦИИ
const TRAITS = {
    backgrounds: [
        { name: 'Cosmic', weight: 5, color: '#1E1B4B' }, { name: 'Starry', weight: 10, color: '#0F172A' },
        { name: 'Electric Purple', weight: 15, color: '#4C1D95' }, { name: 'Grape', weight: 20, color: '#3B0764' },
        { name: 'Golden', weight: 2, color: '#78350F' }, { name: 'Fire', weight: 5, color: '#7F1D1D' },
        { name: 'Ice', weight: 10, color: '#164E63' }, { name: 'Rainbow', weight: 1, color: '#831843' }
    ],
    patterns: [
        { name: 'None', weight: 50, css: 'none' }, { name: 'Stars', weight: 20, css: 'radial-gradient(circle, white 10%, transparent 11%)' },
        { name: 'Waves', weight: 15, css: 'repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(255,255,255,0.1) 10px, rgba(255,255,255,0.1) 20px)' },
        { name: 'Toilet', weight: 1, css: 'repeating-radial-gradient(circle, transparent, transparent 5px, rgba(255,255,255,0.2) 5px, rgba(255,255,255,0.2) 10px)' },
        { name: 'Hexagon', weight: 5, css: 'conic-gradient(from 90deg at 50% 50%, transparent 90deg, rgba(255,255,255,0.1) 0 180deg)' }
    ],
    colors: [
        { name: 'Standard', weight: 60, hex: '#ffffff' }, { name: 'Princess', weight: 15, hex: '#F472B6' },
        { name: 'Gold', weight: 5, hex: '#FBBF24' }, { name: 'Silver', weight: 10, hex: '#94A3B8' },
        { name: 'Emerald', weight: 5, hex: '#34D399' }, { name: 'Ruby', weight: 3, hex: '#EF4444' },
        { name: 'Rainbow', weight: 1, hex: '#8B5CF6' }
    ]
};

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, display_name TEXT,
        six_digit_id TEXT UNIQUE, password TEXT, status TEXT DEFAULT 'online', 
        bio TEXT DEFAULT 'Привет, я использую Rivo!', avatar TEXT DEFAULT '', coins INTEGER DEFAULT 1000
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, creator TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS group_members (group_id INTEGER, username TEXT, PRIMARY KEY (group_id, username))`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, text TEXT, isGift INTEGER, comment TEXT, timestamp TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS promocodes (code TEXT UNIQUE, reward INTEGER, max_uses INTEGER, current_uses INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS blocks (blocker TEXT, blocked TEXT, PRIMARY KEY (blocker, blocked))`);
    db.run(`CREATE TABLE IF NOT EXISTS promo_history (username TEXT, code TEXT, PRIMARY KEY (username, code))`);
    
    // НОВЫЕ ТАБЛИЦЫ
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        gift_id TEXT,
        quantity INTEGER DEFAULT 0,
        UNIQUE(username, gift_id)
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS nfts (
        id TEXT PRIMARY KEY,
        owner TEXT,
        base_type TEXT,
        rarity TEXT,
        background TEXT,
        pattern TEXT,
        color TEXT,
        num INTEGER,
        is_listed INTEGER DEFAULT 0,
        price INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT,
        nft_id TEXT,
        from_user TEXT,
        to_user TEXT,
        price INTEGER,
        timestamp TEXT
    )`);
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

            // ПОКУПКА ПОДАРКА В ИНВЕНТАРЬ
            if (data.type === 'buy_gift') {
                const gift = GIFT_CATALOG[data.gift_id];
                if (!gift) return ws.send(JSON.stringify({ type: 'error', message: 'Подарок не найден.' }));

                db.get(`SELECT coins FROM users WHERE username = ?`, [ws.username], (err, user) => {
                    if (user.coins < gift.price) return ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно R-коинов!' }));
                    
                    // Проверка лимита (считаем сколько в инвентаре + сколько уже улучшено в NFT)
                    db.get(`SELECT SUM(quantity) as inv_count FROM inventory WHERE gift_id = ?`, [gift.id || data.gift_id], (e, inv) => {
                        db.get(`SELECT COUNT(*) as nft_count FROM nfts WHERE base_type = ?`, [data.gift_id], (e2, nftData) => {
                            const totalIssued = (inv ? inv.inv_count || 0 : 0) + (nftData ? nftData.nft_count : 0);
                            if (totalIssued >= gift.max_supply) return ws.send(JSON.stringify({ type: 'error', message: 'Лимит тиража исчерпан!' }));

                            db.run(`BEGIN TRANSACTION`);
                            db.run(`UPDATE users SET coins = coins - ? WHERE username = ?`, [gift.price, ws.username]);
                            db.run(`INSERT INTO inventory (username, gift_id, quantity) VALUES (?, ?, 1) ON CONFLICT(username, gift_id) DO UPDATE SET quantity = quantity + 1`, [ws.username, data.gift_id]);
                            db.run(`COMMIT`);

                            db.get(`SELECT coins FROM users WHERE username = ?`, [ws.username], (e3, r) => {
                                ws.send(JSON.stringify({ type: 'gift_bought', success: true, newBalance: r.coins }));
                            });
                        });
                    });
                });
            }

            // УЛУЧШЕНИЕ ДО NFT
            if (data.type === 'upgrade_to_nft') {
                const baseGiftId = data.base_type;
                
                db.get(`SELECT quantity FROM inventory WHERE username = ? AND gift_id = ?`, [ws.username, baseGiftId], (err, inv) => {
                    if (!inv || inv.quantity < 1) return ws.send(JSON.stringify({ type: 'error', message: 'У вас нет этого подарка!' }));

                    // Генерация характеристик на сервере
                    const getRandomTrait = (traitList) => {
                        let totalWeight = traitList.reduce((sum, t) => sum + t.weight, 0);
                        let random = Math.random() * totalWeight;
                        for (let t of traitList) {
                            if (random < t.weight) return t;
                            random -= t.weight;
                        }
                        return traitList[0];
                    };

                    const bg = getRandomTrait(TRAITS.backgrounds);
                    const pat = getRandomTrait(TRAITS.patterns);
                    const col = getRandomTrait(TRAITS.colors);

                    // Определение редкости на основе весов
                    let rarityScore = bg.weight + pat.weight + col.weight;
                    let rarity = 'Common';
                    if (rarityScore > 80) rarity = 'Legendary';
                    else if (rarityScore > 50) rarity = 'Epic';
                    else if (rarityScore > 30) rarity = 'Rare';
                    else if (rarityScore > 15) rarity = 'Uncommon';

                    const nftId = 'nft_' + Date.now() + Math.floor(Math.random()*1000);
                    const nftNum = Math.floor(1 + Math.random() * 999);

                    db.run(`BEGIN TRANSACTION`);
                    db.run(`UPDATE inventory SET quantity = quantity - 1 WHERE username = ? AND gift_id = ?`, [ws.username, baseGiftId]);
                    db.run(`INSERT INTO nfts (id, owner, base_type, rarity, background, pattern, color, num) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [nftId, ws.username, baseGiftId, rarity, bg.name, pat.name, col.name, nftNum]);
                    db.run(`COMMIT`);

                    ws.send(JSON.stringify({ 
                        type: 'nft_upgraded', 
                        nft: { id: nftId, base_type: baseGiftId, rarity: rarity, background: bg.name, pattern: pat.name, color: col.name, num: nftNum }
                    }));
                });
            }

            if (data.type === 'get_nfts') {
                db.all(`SELECT * FROM nfts WHERE owner = ?`, [data.target], (err, rows) => {
                    ws.send(JSON.stringify({ type: 'user_nfts', nfts: rows || [] }));
                });
            }
            
            if (data.type === 'get_inventory') {
                db.all(`SELECT * FROM inventory WHERE username = ? AND quantity > 0`, [data.target], (err, rows) => {
                    ws.send(JSON.stringify({ type: 'user_inventory', inventory: rows || [] }));
                });
            }

            if (data.type === 'list_nft') {
                db.run(`UPDATE nfts SET is_listed = 1, price = ? WHERE id = ? AND owner = ?`, [data.price, data.nft_id, ws.username], () => {
                    ws.send(JSON.stringify({ type: 'nft_listed', success: true }));
                    broadcastMarketplace();
                });
            }

            if (data.type === 'buy_nft') {
                db.get(`SELECT * FROM nfts WHERE id = ? AND is_listed = 1`, [data.nft_id], (err, nft) => {
                    if (!nft) return ws.send(JSON.stringify({ type: 'error', message: 'NFT уже продан или снят с продажи.' }));
                    if (nft.owner === ws.username) return ws.send(JSON.stringify({ type: 'error', message: 'Вы не можете купить свой NFT.' }));

                    db.get(`SELECT coins FROM users WHERE username = ?`, [ws.username], (e, buyer) => {
                        if (buyer.coins < nft.price) return ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно R-коинов!' }));

                        db.run(`BEGIN TRANSACTION`);
                        db.run(`UPDATE users SET coins = coins - ? WHERE username = ?`, [nft.price, ws.username]);
                        db.run(`UPDATE users SET coins = coins + ? WHERE username = ?`, [nft.price, nft.owner]);
                        db.run(`UPDATE nfts SET owner = ?, is_listed = 0, price = 0 WHERE id = ?`, [ws.username, data.nft_id]);
                        db.run(`INSERT INTO transactions (type, nft_id, from_user, to_user, price, timestamp) VALUES (?, ?, ?, ?, ?, ?)`, 
                        ['sale', data.nft_id, nft.owner, ws.username, nft.price, new Date().toLocaleString()]);
                        db.run(`COMMIT`);

                        ws.send(JSON.stringify({ type: 'nft_bought', success: true }));
                        const sellerSocket = clients.get(nft.owner);
                        if(sellerSocket) sellerSocket.send(JSON.stringify({ type: 'update_coins_force' })); // Просто триггер обновления
                        broadcastMarketplace();
                    });
                });
            }

            if (data.type === 'get_marketplace') {
                db.all(`SELECT * FROM nfts WHERE is_listed = 1`, [], (err, rows) => {
                    ws.send(JSON.stringify({ type: 'marketplace_data', items: rows || [] }));
                });
            }

            // Остальные функции (чаты, промокоды) остались без изменений
            if (data.type === 'get_chat_list') {
                db.all(`SELECT DISTINCT CASE WHEN sender = ? THEN receiver ELSE sender END as contact FROM messages WHERE (sender = ? OR receiver = ?) AND receiver NOT LIKE 'group_%'`, [ws.username, ws.username, ws.username], (err, rows) => {
                    if (!err) ws.send(JSON.stringify({ type: 'chat_list', contacts: rows.map(r => r.contact) }));
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
                    db.all(`SELECT * FROM messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) ORDER BY id ASC`, [ws.username, data.with, data.with, ws.username], (err, rows) => {
                        if (!err) ws.send(JSON.stringify({ type: 'history', with: data.with, messages: rows }));
                    });
                }
            }
            if (data.type === 'get_profile') {
                db.get(`SELECT username, display_name, six_digit_id, status, bio, avatar, coins FROM users WHERE username = ?`, [data.target], (err, user) => {
                    if (err || !user) return ws.send(JSON.stringify({ type: 'error', message: 'Пользователь не найден' }));
                    db.get(`SELECT * FROM blocks WHERE blocker = ? AND blocked = ?`, [ws.username, data.target], (e, iBlocked) => {
                        ws.send(JSON.stringify({ type: 'profile_data', user: user, gifts: [], iBlocked: !!iBlocked }));
                    });
                });
            }
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
            if (data.type === 'admin_give_coins') {
                if (ws.username !== 'revezzz') return ws.send(JSON.stringify({ type: 'error', message: 'Нет прав!' }));
                db.run(`UPDATE users SET coins = coins + ? WHERE username = ?`, [data.amount, data.target], () => {
                    db.get(`SELECT coins FROM users WHERE username = ?`, [data.target], (e, r) => {
                        ws.send(JSON.stringify({ type: 'admin_success', message: `Начислено ${data.amount} R` }));
                        const recipientSocket = clients.get(data.target);
                        if (recipientSocket) recipientSocket.send(JSON.stringify({ type: 'update_coins', coins: r.coins }));
                        if (data.target === ws.username) ws.send(JSON.stringify({ type: 'update_coins', coins: r.coins }));
                    });
                });
            }
            if (data.type === 'create_promo') {
                if (ws.username !== 'revezzz') return ws.send(JSON.stringify({ type: 'promo_result', success: false, message: 'Нет прав!' }));
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
                    db.get(`SELECT * FROM promo_history WHERE username = ? AND code = ?`, [ws.username, code], (err, used) => {
                        if (used) return ws.send(JSON.stringify({ type: 'promo_result', success: false, message: 'Вы уже активировали этот промокод!' }));
                        db.run(`BEGIN TRANSACTION`);
                        db.run(`INSERT INTO promo_history (username, code) VALUES (?, ?)`, [ws.username, code]);
                        db.run(`UPDATE promocodes SET current_uses = current_uses + 1 WHERE code = ?`, [code]);
                        db.run(`UPDATE users SET coins = coins + ? WHERE username = ?`, [row.reward, ws.username]);
                        db.run(`COMMIT`);
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
            clients.forEach((socket) => { if (socket.readyState === WebSocket.OPEN) socket.send(message); });
        }
    });
}

function broadcastMarketplace() {
    db.all(`SELECT * FROM nfts WHERE is_listed = 1`, [], (err, rows) => {
        if (!err) {
            const message = JSON.stringify({ type: 'marketplace_data', items: rows });
            clients.forEach((socket) => { if (socket.readyState === WebSocket.OPEN) socket.send(message); });
        }
    });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Rivo Server запущен на порту ${PORT}`)); 
