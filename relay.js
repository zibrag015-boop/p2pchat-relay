const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
    // ✅ HEALTH CHECK для Render.com
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            uptime: process.uptime(),
            onlineUsers: users.size,
            offlineMessages: Array.from(offlineMessages.values()).reduce((sum, m) => sum + m.length, 0),
            timestamp: new Date().toISOString()
        }));
        return;
    }

    // Главная страница
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
            <html>
                <head>
                    <title>P2P Chat Relay Server v2.1</title>
                    <style>
                        body { font-family: Arial; margin: 40px; background: #f0f0f0; }
                        .container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                        h1 { color: #2c3e50; }
                        .stat { margin: 10px 0; font-size: 16px; }
                        .ok { color: green; font-weight: bold; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>🚀 P2P Chat Relay Server v2.1</h1>
                        <div class="stat">Status: <span class="ok">✅ ONLINE</span></div>
                        <div class="stat">Online Users: <strong>${users.size}</strong></div>
                        <div class="stat">Offline Messages: <strong>${Array.from(offlineMessages.values()).reduce((sum, m) => sum + m.length, 0)}</strong></div>
                        <div class="stat">Uptime: <strong>${Math.floor(process.uptime())}s</strong></div>
                        <hr>
                        <p>WebSocket: <code>wss://p2pchat-relay.onrender.com</code></p>
                        <p><small>Powered by Node.js</small></p>
                    </div>
                </body>
            </html>
        `);
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

const wss = new WebSocket.Server({ server });

// ✅ ХРАНИЛИЩЕ
const users = new Map();           // { username: websocket }
const offlineMessages = new Map(); // { username: [{ from, content, timestamp, expiry }] }
const userStats = new Map();       // { username: { messageCount, lastReset } } - для rate limiting
const blacklist = new Map();       // { username: blacklistUntil } - для блокировки спамеров

// ✅ КОНСТАНТЫ
const MESSAGE_STORAGE_TIME = 86400 * 1000;     // 24 часа в миллисекундах
const MAX_MESSAGE_SIZE = 100 * 1024;            // 100 KB максимум
const MAX_MESSAGES_PER_SECOND = 100;           // 100 сообщений в сек на пользователя
const RATE_LIMIT_WINDOW = 1000;                // 1 секунда
const BLACKLIST_DURATION = 60 * 1000;          // 1 минута блокировки

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║  🚀 P2P CHAT RELAY SERVER v2.1 - STARTING UP...         ║');
console.log('║  ✅ WITH HEALTH CHECK, RATE LIMITING & SIZE VALIDATION   ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

// ═══════════════════════════════════════════════════════════════════
// 🟢 КОГДА ПОЛЬЗОВАТЕЛЬ ПОДКЛЮЧИЛСЯ
// ═══════════════════════════════════════════════════════════════════

wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(`\n[+] NEW CONNECTION from ${clientIp}`);
    console.log(`    Total clients: ${wss.clients.size}`);

    let username = null;
    let isAuthenticated = false;

    ws.on('message', (data) => {
        try {
            // ✅ Проверка размера сообщения
            if (data.length > MAX_MESSAGE_SIZE) {
                console.log(`[❌] ${clientIp}: Message too large (${data.length} bytes)`);
                ws.send('ERROR:Message exceeds maximum size of 100KB');
                return;
            }

            const message = data.toString().trim();
            
            if (!isAuthenticated && !message.startsWith('USER:')) {
                console.log(`[⚠️] ${clientIp} попытался отправить сообщение без регистрации`);
                ws.send('ERROR:You must register first');
                return;
            }

            // ═══════════════════════════════════════════════════════════════════
            // 1️⃣ РЕГИСТРАЦИЯ ПОЛЬЗОВАТЕЛЯ
            // ═══════════════════════════════════════════════════════════════════
            if (message.startsWith('USER:')) {
                username = message.substring(5).trim();
                
                if (!username || username.length === 0) {
                    ws.send('ERROR:Invalid username');
                    return;
                }

                // ✅ Проверка черного списка
                if (blacklist.has(username) && Date.now() < blacklist.get(username)) {
                    ws.send('ERROR:You are temporarily blocked');
                    console.log(`[🚫] ${username} попытался подключиться в то время как в черном списке`);
                    return;
                }

                // ✅ Удаляем из черного списка если истёк срок
                if (blacklist.has(username) && Date.now() >= blacklist.get(username)) {
                    blacklist.delete(username);
                }

                users.set(username, ws);
                isAuthenticated = true;
                
                // Инициализируем статистику
                if (!userStats.has(username)) {
                    userStats.set(username, { messageCount: 0, lastReset: Date.now() });
                }
                
                console.log(`[✅] ${username} зарегистрирован`);
                console.log(`    📍 Онлайн (${users.size}): ${Array.from(users.keys()).join(', ')}`);

                // Отправляем подтверждение
                ws.send('CONNECTED');

                // Рассылаем обновленный список пользователей ВСЕМ
                broadcastUsersList();

                // Отправляем ожидающие сообщения ЭТОМУ пользователю
                if (offlineMessages.has(username)) {
                    const messages = offlineMessages.get(username);
                    console.log(`[📦] ${username} имеет ${messages.length} офлайн сообщений`);

                    for (const msg of messages) {
                        ws.send(`OFFLINE_MSG:${msg.from}|||${msg.content}|||OFFLINE`);
                        console.log(`    [📤] Отправили офлайн сообщение от ${msg.from}`);
                    }

                    // Очищаем очередь
                    offlineMessages.delete(username);
                }

                return;
            }

            // ✅ RATE LIMITING
            if (username) {
                const stats = userStats.get(username) || { messageCount: 0, lastReset: Date.now() };
                const now = Date.now();

                if (now - stats.lastReset > RATE_LIMIT_WINDOW) {
                    stats.messageCount = 0;
                    stats.lastReset = now;
                }

                stats.messageCount++;
                userStats.set(username, stats);

                if (stats.messageCount > MAX_MESSAGES_PER_SECOND) {
                    console.log(`[⚠️] ${username}: Rate limit exceeded!`);
                    ws.send('ERROR:Rate limit exceeded. Max 100 messages per second');
                    
                    // Добавляем в черный список
                    blacklist.set(username, Date.now() + BLACKLIST_DURATION);
                    return;
                }
            }

            // ═══════════════════════════════════════════════════════════════════
            // 2️⃣ ЗАПРОС СПИСКА ПОЛЬЗОВАТЕЛЕЙ
            // ═══════════════════════════════════════════════════════════════════
            if (message === 'GET_USERS') {
                const usersList = Array.from(users.keys())
                    .filter(u => u !== username)
                    .join(',');
                ws.send(`USERS:${usersList}`);
                console.log(`[👥] ${username} запросил список. Онлайн: ${usersList || 'никого'}`);
                return;
            }

            // ═══════════════════════════════════════════════════════════════════
            // 3️⃣ ЗАПРОС ОЖИДАЮЩИХ СООБЩЕНИЙ
            // ═══════════════════════════════════════════════════════════════════
            if (message === 'GET_OFFLINE_MESSAGES') {
                if (offlineMessages.has(username)) {
                    const messages = offlineMessages.get(username);
                    console.log(`[📦] Отправляем ${messages.length} офлайн сообщений для ${username}`);

                    for (const msg of messages) {
                        ws.send(`OFFLINE_MSG:${msg.from}|||${msg.content}|||OFFLINE`);
                    }

                    offlineMessages.delete(username);
                } else {
                    console.log(`[✅] Нет офлайн сообщений для ${username}`);
                }
                return;
            }

            // ═══════════════════════════════════════════════════════════════════
            // 4️⃣ ОТПРАВКА СООБЩЕНИЯ
            // Формат: "MSG:sender|||recipient|||[зашифровано]|||STORE|||86400"
            // ═══════════════════════════════════════════════════════════════════
            if (message.startsWith('MSG:')) {
                const parts = message.substring(4).split('|||');

                if (parts.length < 3) {
                    console.log(`[❌] ${username}: Некорректный формат сообщения`);
                    ws.send('ERROR:Invalid message format');
                    return;
                }

                const sender = parts[0];
                const recipient = parts[1];
                const encryptedContent = parts[2];
                const shouldStore = parts[3] === 'STORE';
                const storageTimeSeconds = parseInt(parts[4]) || 86400;
                const storageTime = storageTimeSeconds * 1000; // В миллисекунды

                console.log(`\n[📤] СООБЩЕНИЕ:`);
                console.log(`    От: ${sender}`);
                console.log(`    Кому: ${recipient}`);
                console.log(`    Размер: ${encryptedContent.length} символов`);
                console.log(`    Хранить: ${shouldStore ? 'ДА (' + storageTimeSeconds + 'с)' : 'НЕТ'}`);

                // ✅ ВАРИАНТ 1: Получатель ОНЛАЙН
                if (users.has(recipient)) {
                    const recipientWs = users.get(recipient);
                    recipientWs.send(`MSG:${sender}|||${recipient}|||${encryptedContent}`);
                    console.log(`    ✅ ДОСТАВЛЕНО ОНЛАЙН`);
                }
                // ✅ ВАРИАНТ 2: Получатель ОФЛАЙН
                else {
                    if (shouldStore) {
                        // Сохраняем в очередь
                        if (!offlineMessages.has(recipient)) {
                            offlineMessages.set(recipient, []);
                        }

                        const expiry = Date.now() + storageTime;
                        offlineMessages.get(recipient).push({
                            from: sender,
                            content: encryptedContent,
                            timestamp: Date.now(),
                            expiry: expiry
                        });

                        console.log(`    📦 СОХРАНЕНО (на ${storageTimeSeconds}s)`);
                        console.log(`    💾 Всего офлайн сообщений для ${recipient}: ${offlineMessages.get(recipient).length}`);

                        // Запланируем удаление сообщения по TTL
                        setTimeout(() => {
                            const msgs = offlineMessages.get(recipient);
                            if (msgs) {
                                const index = msgs.findIndex(m => m.expiry === expiry);
                                if (index !== -1) {
                                    msgs.splice(index, 1);
                                    console.log(`[🗑️] Удалили истёкшее сообщение от ${sender} -> ${recipient}`);
                                    
                                    if (msgs.length === 0) {
                                        offlineMessages.delete(recipient);
                                    }
                                }
                            }
                        }, storageTime);

                    } else {
                        console.log(`    ❌ ${recipient} ОФЛАЙН - СООБЩЕНИЕ ПОТЕРЯНО (хранение отключено)`);
                    }
                }

                return;
            }

            // ═══════════════════════════════════════════════════════════════════
            // 5️⃣ HEARTBEAT (PING/PONG)
            // ═══════════════════════════════════════════════════════════════════
            if (message === 'PING') {
                ws.send('PONG');
                console.log(`[💓] ${username}: ping -> pong`);
                return;
            }

            console.log(`[?] ${username}: Неизвестная команда: ${message.substring(0, 50)}`);

        } catch (error) {
            console.error(`[⚠️] Ошибка обработки сообщения: ${error.message}`);
            ws.send(`ERROR:${error.message}`);
        }
    });

    // ═══════════════════════════════════════════════════════════════════
    // 🔴 КОГДА ПОЛЬЗОВАТЕЛЬ ОТКЛЮЧИЛСЯ
    // ═══════════════════════════════════════════════════════════════════

    ws.on('close', () => {
        if (username && isAuthenticated) {
            users.delete(username);
            console.log(`\n[-] ${username} отключился`);
            console.log(`    📍 Онлайн (${users.size}): ${Array.from(users.keys()).join(', ') || 'никого'}`);

            // Оповещаем остальных об изменении списка
            broadcastUsersList();
        }
    });

    ws.on('error', (error) => {
        console.error(`[⚠️] Ошибка WebSocket для ${username || 'UNKNOWN'}: ${error.message}`);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 📢 РАССЫЛКА СПИСКА ПОЛЬЗОВАТЕЛЕЙ ВСЕМ
// ═══════════════════════════════════════════════════════════════════

function broadcastUsersList() {
    const usersList = Array.from(users.keys());
    console.log(`[📢] Рассылаем список (${usersList.length} пользователей)`);

    for (const [username, ws] of users) {
        const others = usersList
            .filter(u => u !== username)
            .join(',');
        ws.send(`USERS:${others}`);
    }
}

// ═══════════════════════════════════════════════════════════════════
// 📊 СТАТИСТИКА И МОНИТОРИНГ
// ═══════════════════════════════════════════════════════════════════

setInterval(() => {
    const onlineCount = users.size;
    const offlineCount = offlineMessages.size;
    const totalOfflineMessages = Array.from(offlineMessages.values())
        .reduce((sum, msgs) => sum + msgs.length, 0);
    const blacklistCount = Array.from(blacklist.values()).filter(exp => Date.now() < exp).length;

    console.log(`\n[📊] СТАТИСТИКА:`);
    console.log(`    Онлайн: ${onlineCount} пользователей`);
    console.log(`    Офлайн: ${offlineCount} пользователей с сообщениями`);
    console.log(`    В очереди: ${totalOfflineMessages} сообщений`);
    console.log(`    В черном списке: ${blacklistCount} пользователей`);
    console.log(`    Uptime: ${Math.floor(process.uptime())}s`);
}, 30000);

// ═══════════════════════════════════════════════════════════════════
// 🚀 ЗАПУСК СЕРВЕРА
// ═══════════════════════════════════════════════════════════════════

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔════════════════════════════════════════════════════════════╗`);
    console.log(`║                                                            ║`);
    console.log(`║           ✅ RELAY SERVER READY - UNLIMITED USERS          ║`);
    console.log(`║                                                            ║`);
    console.log(`║  Port: ${PORT.toString().padEnd(50)}║`);
    console.log(`║  WebSocket: wss://p2pchat-relay.onrender.com               ║`);
    console.log(`║  Health Check: https://p2pchat-relay.onrender.com/health   ║`);
    console.log(`║                                                            ║`);
    console.log(`║  Features:                                                 ║`);
    console.log(`║  ✓ UNLIMITED concurrent users                              ║`);
    console.log(`║  ✓ Offline message storage (24 hours)                      ║`);
    console.log(`║  ✓ End-to-End Encryption                                   ║`);
    console.log(`║  ✓ WebSocket routing                                       ║`);
    console.log(`║  ✓ User presence broadcasting                              ║`);
    console.log(`║  ✓ Heartbeat monitoring                                    ║`);
    console.log(`║  ✓ Rate limiting & Spam protection                         ║`);
    console.log(`║  ✓ Message size validation (100KB max)                     ║`);
    console.log(`║  ✓ Health check endpoint                                   ║`);
    console.log(`║                                                            ║`);
    console.log(`╚════════════════════════════════════════════════════════════╝\n`);
});

// ═══════════════════════════════════════════════════════════════════
// ✅ КОРРЕКТНОЕ ЗАВЕРШЕНИЕ
// ═══════════════════════════════════════════════════════════════════

process.on('SIGINT', () => {
    console.log('\n[🛑] SHUTTING DOWN SERVER...');
    
    for (const [username, ws] of users) {
        ws.close();
        console.log(`[-] Закрыли соединение для ${username}`);
    }
    users.clear();
    offlineMessages.clear();
    blacklist.clear();

    server.close(() => {
        console.log('[✅] SERVER STOPPED');
        process.exit(0);
    });

    setTimeout(() => {
        console.log('[⚠️] Forced shutdown');
        process.exit(1);
    }, 5000);
});

process.on('uncaughtException', (error) => {
    console.error('[❌] UNCAUGHT EXCEPTION:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[❌] UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

module.exports = { users, offlineMessages, userStats, blacklist };

