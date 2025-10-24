// Импортируем модули TLS (для HTTPS) и файловую систему
const tls = require('tls');
const fs = require('fs');

// Порт сервера: 443 (стандартный HTTPS)
const PORT = 443;

// Map для хранения подключённых клиентов (имя пользователя → сокет)
const clients = new Map();

// Загружаем SSL сертификаты для HTTPS
const tlsOptions = {
    key: fs.readFileSync('./key.pem'),      // Приватный ключ
    cert: fs.readFileSync('./cert.pem')     // Сертификат
};

// Создаём HTTPS сервер
const server = tls.createServer(tlsOptions, (socket) => {
    // Когда новый клиент подключается
    console.log('New client connected (HTTPS)');
    
    // Переменная для хранения имени подключённого пользователя
    let username = null;
    
    // Событие: когда приходят данные от клиента
    socket.on('data', (data) => {
        // Конвертируем данные в текст (UTF-8) и удаляем пробелы с краёв
        const message = data.toString('utf-8').trim();
        // Выводим время и полученное сообщение в логи
        console.log(`[${new Date().toISOString()}] Received: ${message}`);
        
        // БЛОК 1: Регистрация пользователя
        if (message.startsWith('USER:')) {
            // Извлекаем имя пользователя (всё после "USER:")
            username = message.substring(5);
            // Добавляем клиента в список подключённых
            clients.set(username, socket);
            // Выводим: кто подключился и сколько всего клиентов
            console.log(`User ${username} registered (Total: ${clients.size})`);
            // Отправляем клиенту подтверждение
            socket.write('CONNECTED\n');
            return;
        }
        
        // БЛОК 2: Передача зашифрованных сообщений (сервер НИЧЕГО не расшифровывает!)
        if (message.startsWith('MSG:')) {
            // Извлекаем зашифрованные данные (всё после "MSG:")
            const encryptedMsg = message.substring(4);
            
            // Счётчик для отслеживания, кому отправили сообщение
            let sentCount = 0;
            
            // Проходим по всем подключённым клиентам
            clients.forEach((clientSocket, clientUsername) => {
                // Если это НЕ отправитель И сокет активен
                if (clientUsername !== username && clientSocket.writable) {
                    // Отправляем сообщение другому клиенту (БЕЗ расшифровки!)
                    clientSocket.write(`MSG:${encryptedMsg}\n`);
                    sentCount++;  // Увеличиваем счётчик
                }
            });
            // Выводим в логи: кому отправили сообщение
            console.log(`Message from ${username} sent to ${sentCount} client(s)`);
            return;
        }
    });
    
    // Событие: когда клиент отключается
    socket.on('end', () => {
        if (username) {
            // Удаляем клиента из списка подключённых
            clients.delete(username);
            // Выводим: кто отключился и сколько осталось клиентов
            console.log(`User ${username} disconnected (Total: ${clients.size})`);
        }
    });
    
    // Событие: ошибка на сокете
    socket.on('error', (err) => {
        // Выводим ошибку в логи
        console.error('Socket error:', err);
    });
});

// Запускаем сервер на порту 443, слушаем все IP адреса (0.0.0.0)
server.listen(PORT, '0.0.0.0', () => {
    // Выводим в логи: на каком порту работает сервер
    console.log(`[HTTPS] Relay server listening on port ${PORT}`);
    // Напоминаем проверить сертификат
    console.log(`Make sure SSL certificate is valid!`);
});
