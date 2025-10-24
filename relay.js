const WebSocket = require('ws');
const http = require('http');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const clients = new Map();

wss.on('connection', (ws) => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] Client connected`);
    let username = null;

    ws.on('message', (message) => {
        const text = message.toString().trim();
        const ts = new Date().toISOString();
        
        if (text.startsWith('USER:')) {
            username = text.substring(5);
            clients.set(username, { ws, username });
            console.log(`[${ts}] [USER] ${username} registered`);
            ws.send('CONNECTED\n');
        } 
        else if (text.startsWith('MSG:')) {
            const msg = text.substring(4);
            console.log(`[${ts}] [RECEIVED] FROM: ${username}`);
            console.log(`[${ts}] [RECEIVED] MSG: ${msg.substring(0, 50)}...`);
            
            clients.forEach((client, name) => {
                if (client.ws.readyState === WebSocket.OPEN && name !== username) {
                    console.log(`[${ts}] [SENT] TO: ${name}`);
                    console.log(`[${ts}] [SENT] MSG: ${msg.substring(0, 50)}...`);
                    client.ws.send('MSG:' + msg + '\n');  // ✅ Отправляет текстом
                }
            });
        }
    });

    ws.on('close', () => {
        const ts = new Date().toISOString();
        if (username) {
            clients.delete(username);
            console.log(`[${ts}] [CLOSE] ${username} disconnected`);
        }
    });

    ws.on('error', (error) => {
        const ts = new Date().toISOString();
        console.error(`[${ts}] [ERROR] ${error.message}`);
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] [START] WebSocket server running on port ${PORT}`);
});
