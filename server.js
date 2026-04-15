const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const sessions = new Map();
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir);

app.get('/', (req, res) => {
    res.json({ status: 'running', message: 'WhatsApp API Server is running', sessions: sessions.size });
});

app.post('/create-session', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    
    if (sessions.has(sessionId)) {
        return res.json({ message: 'Session already exists', qr: null });
    }
    
    let qrSent = false;
    const timeout = setTimeout(() => {
        if (!qrSent) res.status(408).json({ error: 'QR generation timeout' });
    }, 60000);
    
    try {
        const authPath = path.join(sessionsDir, sessionId);
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const sock = makeWASocket({ auth: state, printQRInTerminal: false });
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && !qrSent) {
                qrSent = true;
                clearTimeout(timeout);
                const qrBuffer = await QRCode.toBuffer(qr);
                res.json({ qr: qr, status: 'qr_ready' });
            }
            
            if (connection === 'open') {
                sessions.set(sessionId, sock);
                console.log(`✅ Session ${sessionId} connected`);
                sock.ev.on('creds.update', saveCreds);
            }
            
            if (connection === 'close') {
                sessions.delete(sessionId);
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                }
            }
        });
    } catch (error) {
        clearTimeout(timeout);
        res.status(500).json({ error: error.message });
    }
});

app.post('/send-message', async (req, res) => {
    const { sessionId, number, message } = req.body;
    const sock = sessions.get(sessionId);
    if (!sock) return res.status(404).json({ error: 'Session not found. Please connect WhatsApp first.' });
    
    try {
        let formattedNumber = number.toString().replace(/[^0-9]/g, '');
        if (formattedNumber.startsWith('01')) formattedNumber = '88' + formattedNumber;
        if (!formattedNumber.endsWith('@c.us')) formattedNumber = formattedNumber + '@c.us';
        
        await sock.sendMessage(formattedNumber, { text: message });
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/session-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    res.json({ connected: sessions.has(sessionId) });
});

app.post('/disconnect', async (req, res) => {
    const { sessionId } = req.body;
    if (sessions.has(sessionId)) {
        await sessions.get(sessionId).logout();
        sessions.delete(sessionId);
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
