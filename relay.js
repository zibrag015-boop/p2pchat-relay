const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// ✅ ХРАНИЛИЩЕ
const users = new Map();           // { username: websocket }
const offlineMessages = new Map(); // { username: [{ from, content, timestamp, expiry }] }

// ✅ КОНСТАНТЫ
const MESSAGE_STORAGE_TIME = 86400 * 1000; // 24 часа в миллисекундах

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║  🚀 P2P CHAT RELAY SERVER v2.1 - STARTING UP...         ║');
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
            const message = data.toString().trim();
            
            if (!isAuthenticated && !message.startsWith('USER:')) {
                console.log(`[⚠️] ${clientIp} попытался отправить сообщение без регистрации`);
                ws.send('ERROR:You must register first');
                return;
            }

            // ═══════════════════════════════════════════════════════════════════
            // 1️⃣ РЕГИСТРАЦИЯ ПОЛЬЗОВАТЕЛЯ (✅ ИСПРАВЛЕНО - БЕЗ ЗАКРЫТИЯ СТАРЫХ!)
            // ═══════════════════════════════════════════════════════════════════
            if (message.startsWith('USER:')) {
                username = message.substring(5).trim();
                
                if (!username || username.length === 0) {
                    ws.send('ERROR:Invalid username');
                    return;
                }

                // ✅ ПРОСТО ДОБАВЛЯЕМ В MAP (РАЗРЕШАЕМ НЕСКОЛЬКО ПОЛЬЗОВАТЕЛЕЙ!)
                users.set(username, ws);
                isAuthenticated = true;
                
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
                        const timeoutId = setTimeout(() => {
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

    console.log(`\n[📊] СТАТИСТИКА:`);
    console.log(`    Онлайн: ${onlineCount} пользователей`);
    console.log(`    Офлайн: ${offlineCount} пользователей с сообщениями`);
    console.log(`    В очереди: ${totalOfflineMessages} сообщений`);
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
    console.log(`║  WebSocket: ws://0.0.0.0:${PORT.toString().padEnd(42)}║`);
    console.log(`║                                                            ║`);
    console.log(`║  Features:                                                 ║`);
    console.log(`║  ✓ UNLIMITED concurrent users                              ║`);
    console.log(`║  ✓ Offline message storage (24 hours)                      ║`);
    console.log(`║  ✓ End-to-End Encryption                                   ║`);
    console.log(`║  ✓ WebSocket routing                                       ║`);
    console.log(`║  ✓ User presence broadcasting                              ║`);
    console.log(`║  ✓ Heartbeat monitoring                                    ║`);
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

module.exports = { users, offlineMessages };
