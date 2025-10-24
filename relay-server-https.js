const http = require('http');

const PORT = 8080;
const clients = new Map();

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Relay Server Running');
});

const net = require('net');
const tcpServer = net.createServer((socket) => {
    console.log('New client connected');
    
    let username = null;
    
    socket.on('data', (data) => {
        const message = data.toString('utf-8').trim();
        console.log(`[${new Date().toISOString()}] Received: ${message}`);
        
        if (message.startsWith('USER:')) {
            username = message.substring(5);
            clients.set(username, socket);
            console.log(`User ${username} registered (Total: ${clients.size})`);
            socket.write('CONNECTED\n');
            return;
        }
        
        if (message.startsWith('MSG:')) {
            const encryptedMsg = message.substring(4);
            
            let sentCount = 0;
            clients.forEach((clientSocket, clientUsername) => {
                if (clientUsername !== username && clientSocket.writable) {
                    clientSocket.write(`MSG:${encryptedMsg}\n`);
                    sentCount++;
                }
            });
            console.log(`Message from ${username} sent to ${sentCount} client(s)`);
            return;
        }
    });
    
    socket.on('end', () => {
        if (username) {
            clients.delete(username);
            console.log(`User ${username} disconnected (Total: ${clients.size})`);
        }
    });
    
    socket.on('error', (err) => {
        console.error('Socket error:', err);
    });
});

tcpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Relay server listening on port ${PORT}`);
});
