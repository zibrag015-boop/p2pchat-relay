const WebSocket = require('ws');
const http = require('http');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const clients = new Map(); // username -> {ws, username}

wss.on('connection', (ws) => {
    console.log('[' + new Date().toISOString() + '] Client connected');
    let username = null;

    ws.on('message', (message) => {
        const text = message.toString().trim();
        
        if (text.startsWith('USER:')) {
            username = text.substring(5);
            clients.set(username, { ws, username });
            console.log(`[USER] ${username} registered`);
            ws.send('CONNECTED\n');
        } 
        else if (text.startsWith('MSG:')) {
            const msg = text.substring(4);
            console.log(`[MSG] ${username}: ${msg.substring(0, 50)}...`);
            
            // ✅ Ретранслируем ТОЛЬКО текст
            clients.forEach((client, name) => {
                if (client.ws.readyState === WebSocket.OPEN && name !== username) {
                    console.log(`[MSG] Forwarding to ${name}`);
                    client.ws.send(message);
                }
            });
        }
    });

    ws.on('close', () => {
        if (username) {
            clients.delete(username);
            console.log(`[CLOSE] ${username} disconnected`);
        }
    });

    ws.on('error', (error) => {
        console.error(`[ERROR] ${error.message}`);
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`[START] WebSocket server running on port ${PORT}`);
});
