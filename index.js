const express = require('express');
const multer = require('multer');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { default: makeWASocket, Browsers, delay, useMultiFileAuthState, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const app = express();
const upload = multer();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

const activeSessions = new Map();
const sessionLogs = new Map();
const sessionConnections = new Map();

// Configure static files and body parsing
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));

// Ensure sessions directory exists
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// WebSocket for real-time logs
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'subscribe') {
                const sessionKey = data.sessionKey;
                if (sessionLogs.has(sessionKey)) {
                    ws.sessionKey = sessionKey;
                    ws.send(JSON.stringify({
                        type: 'logs',
                        data: sessionLogs.get(sessionKey)
                    }));
                }
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });
});

function broadcastLogs(sessionKey, message) {
    if (!sessionLogs.has(sessionKey)) {
        sessionLogs.set(sessionKey, []);
    }
    const logs = sessionLogs.get(sessionKey);
    const timestamp = new Date().toLocaleTimeString();
    logs.push(`[${timestamp}] ${message}`);
    if (logs.length > 500) logs.shift();
    
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.sessionKey === sessionKey) {
            client.send(JSON.stringify({
                type: 'log',
                data: message
            }));
        }
    });
}

// API Endpoints
app.post('/send', upload.single('sms'), async (req, res) => {
    try {
        const { creds, targetNumber, targetType, timeDelay, hatersName } = req.body;
        const smsFile = req.file.buffer;

        const sessionKey = crypto.randomBytes(8).toString('hex');
        const sessionDir = path.join(sessionsDir, sessionKey);

        // Save session data
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'creds.json'), Buffer.from(creds, 'base64').toString('utf-8'));

        // Process messages
        const messages = smsFile.toString('utf8')
            .split('\n')
            .map(line => `${hatersName} ${line.trim()}`)
            .filter(line => line);

        // Initialize session
        activeSessions.set(sessionKey, {
            running: true,
            targetNumber,
            targetType,
            startTime: new Date(),
            sentCount: 0,
            failedCount: 0,
            lastActivity: new Date()
        });
        sessionLogs.set(sessionKey, []);

        // Start message sending
        sendMessages(sessionKey, path.join(sessionDir, 'creds.json'), messages, targetNumber, targetType, parseInt(timeDelay, 10) * 1000);

        res.json({ 
            success: true,
            sessionKey,
            message: `Session started successfully. Use key: ${sessionKey} to monitor.`
        });
    } catch (error) {
        console.error('Send error:', error);
        res.status(500).json({ 
            success: false,
            message: 'Failed to start session: ' + error.message
        });
    }
});

app.post('/stop', (req, res) => {
    try {
        const { sessionKey } = req.body;
        
        if (!activeSessions.has(sessionKey)) {
            return res.status(404).json({ 
                success: false,
                message: 'Session not found'
            });
        }

        // Stop the session
        const session = activeSessions.get(sessionKey);
        session.running = false;
        activeSessions.set(sessionKey, session);

        // Clean up connection
        if (sessionConnections.has(sessionKey)) {
            const sock = sessionConnections.get(sessionKey);
            sock.end();
            sessionConnections.delete(sessionKey);
        }

        // Delete session files
        const sessionDir = path.join(sessionsDir, sessionKey);
        fs.rm(sessionDir, { recursive: true, force: true }, (err) => {
            if (err) console.error('Cleanup error:', err);
        });

        broadcastLogs(sessionKey, '[SYSTEM] Session stopped by user');
        
        res.json({ 
            success: true,
            message: `Session ${sessionKey} stopped successfully`
        });
    } catch (error) {
        console.error('Stop error:', error);
        res.status(500).json({ 
            success: false,
            message: 'Failed to stop session'
        });
    }
});

app.get('/status/:sessionKey', (req, res) => {
    try {
        const { sessionKey } = req.params;
        
        if (!activeSessions.has(sessionKey)) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }

        const session = activeSessions.get(sessionKey);
        res.json({
            success: true,
            running: session.running,
            targetNumber: session.targetNumber,
            targetType: session.targetType,
            startTime: session.startTime,
            sentCount: session.sentCount,
            failedCount: session.failedCount,
            lastActivity: session.lastActivity
        });
    } catch (error) {
        console.error('Status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get session status'
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        activeSessions: activeSessions.size,
        memoryUsage: process.memoryUsage()
    });
});

// Session cleanup every 5 minutes
setInterval(() => {
    const now = new Date();
    activeSessions.forEach((session, key) => {
        // Skip running sessions
        if (session.running) return;

        // Cleanup stopped sessions older than 1 hour
        if ((now - new Date(session.lastActivity)) > 3600000) {
            const sessionDir = path.join(sessionsDir, key);
            fs.rm(sessionDir, { recursive: true, force: true }, (err) => {
                if (err) console.error('Cleanup error:', err);
            });
            activeSessions.delete(key);
            sessionLogs.delete(key);
        }
    });
}, 300000);

async function sendMessages(sessionKey, credsPath, messages, targetNumber, targetType, delayMs) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.dirname(credsPath));
        
        const sock = makeWASocket({
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            browser: Browsers.windows('Firefox'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino().child({ level: "fatal" })),
            },
        });

        sessionConnections.set(sessionKey, sock);
        
        // Reconnect logic
        let reconnectAttempts = 0;
        const maxReconnectAttempts = 15;
        
        const reconnect = async () => {
            if (!activeSessions.get(sessionKey)?.running || reconnectAttempts >= maxReconnectAttempts) {
                return;
            }
            
            reconnectAttempts++;
            broadcastLogs(sessionKey, `[SYSTEM] Reconnecting (attempt ${reconnectAttempts}/${maxReconnectAttempts})`);
            
            try {
                await sock.end();
                const { state, saveCreds } = await useMultiFileAuthState(path.dirname(credsPath));
                const newSock = makeWASocket({
                    logger: pino({ level: 'silent' }),
                    printQRInTerminal: true,
                    browser: Browsers.windows('Firefox'),
                    auth: {
                        creds: state.creds,
                        keys: makeCacheableSignalKeyStore(state.keys, pino().child({ level: "fatal" })),
                    },
                });
                
                sessionConnections.set(sessionKey, newSock);
                setupEventHandlers(newSock);
                broadcastLogs(sessionKey, '[SYSTEM] Reconnected successfully');
                reconnectAttempts = 0;
            } catch (error) {
                broadcastLogs(sessionKey, `[ERROR] Reconnect failed: ${error.message}`);
                setTimeout(reconnect, 10000);
            }
        };
        
        const setupEventHandlers = (socket) => {
            socket.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                if (qr) {
                    broadcastLogs(sessionKey, '[SYSTEM] Scan QR code to continue session');
                }
                
                if (connection === 'open') {
                    broadcastLogs(sessionKey, '[SYSTEM] Connected to WhatsApp');
                    
                    // Update session activity
                    const session = activeSessions.get(sessionKey);
                    session.lastActivity = new Date();
                    activeSessions.set(sessionKey, session);
                    
                    // Start sending messages
                    for (const message of messages) {
                        if (!activeSessions.get(sessionKey)?.running) break;
                        
                        try {
                            const recipient = targetType === 'inbox' 
                                ? `${targetNumber}@s.whatsapp.net` 
                                : targetNumber;
                            
                            await socket.sendMessage(recipient, { text: message });
                            
                            // Update success count
                            const session = activeSessions.get(sessionKey);
                            session.sentCount++;
                            session.lastActivity = new Date();
                            activeSessions.set(sessionKey, session);
                            
                            broadcastLogs(sessionKey, `[SUCCESS] Sent to ${targetNumber}: ${message.substring(0, 30)}...`);
                            
                            await delay(delayMs);
                        } catch (error) {
                            // Update failure count
                            const session = activeSessions.get(sessionKey);
                            session.failedCount++;
                            session.lastActivity = new Date();
                            activeSessions.set(sessionKey, session);
                            
                            broadcastLogs(sessionKey, `[ERROR] Failed to send: ${error.message}`);
                            
                            // If connection error, attempt reconnect
                            if (error.message.includes('connection') || error.message.includes('socket')) {
                                await delay(5000);
                                break;
                            }
                            
                            await delay(5000);
                        }
                    }
                    
                    // Check if completed
                    if (activeSessions.get(sessionKey)?.running) {
                        broadcastLogs(sessionKey, '[SYSTEM] Message sending completed');
                        const session = activeSessions.get(sessionKey);
                        session.running = false;
                        activeSessions.set(sessionKey, session);
                        
                        // Cleanup
                        fs.rm(path.dirname(credsPath), { recursive: true, force: true }, (err) => {
                            if (err) console.error('Cleanup error:', err);
                        });
                        
                        if (sessionConnections.has(sessionKey)) {
                            sessionConnections.get(sessionKey).end();
                            sessionConnections.delete(sessionKey);
                        }
                    }
                } else if (connection === 'close') {
                    const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== 401);
                    if (shouldReconnect && activeSessions.get(sessionKey)?.running) {
                        broadcastLogs(sessionKey, '[SYSTEM] Connection closed, reconnecting...');
                        setTimeout(reconnect, 10000);
                    } else {
                        broadcastLogs(sessionKey, '[ERROR] Connection closed permanently');
                    }
                }
            });
            
            socket.ev.on('creds.update', saveCreds);
        };
        
        setupEventHandlers(sock);
    } catch (error) {
        broadcastLogs(sessionKey, `[ERROR] Initialization failed: ${error.message}`);
        console.error('Initialization error:', error);
        
        if (activeSessions.has(sessionKey)) {
            const session = activeSessions.get(sessionKey);
            session.running = false;
            activeSessions.set(sessionKey, session);
        }
        
        // Cleanup
        fs.rm(path.dirname(credsPath), { recursive: true, force: true }, (err) => {
            if (err) console.error('Cleanup error:', err);
        });
    }
}

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Error handling
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
