const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

// সেশন স্টোর (মেমোরিতে)
const sessions = new Map();

// লগ ফাংশন
function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

// হোম পেজ - চেক করার জন্য
app.get('/', (req, res) => {
    res.json({ 
        status: 'running', 
        message: 'WhatsApp API Server is running', 
        sessions: sessions.size 
    });
});

// সেশন তৈরি ও QR কোড পাওয়া
app.post('/create-session', async (req, res) => {
    const { sessionId } = req.body;
    log(`Session request: ${sessionId}`);
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }
    
    // যদি আগে থেকেই সংযুক্ত থাকে
    if (sessions.has(sessionId)) {
        log(`Session ${sessionId} already connected`);
        return res.json({ status: 'already_connected', message: 'Already connected' });
    }
    
    // টাইমআউট (১ মিনিট)
    const timeout = setTimeout(() => {
        if (!res.headersSent) {
            res.status(408).json({ error: 'QR generation timeout' });
        }
    }, 60000);
    
    try {
        // অথেন্টিকেশন স্টেট লোড (টেম্প ফোল্ডার)
        const { state, saveCreds } = await useMultiFileAuthState(`/tmp/${sessionId}`);
        
        // সকেট তৈরি
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            browser: ['WhatsApp API', 'Chrome', '1.0']
        });
        
        // QR বা সংযোগ আপডেট শোনা
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                log(`QR received for ${sessionId}`);
                clearTimeout(timeout);
                
                // QR কোড ক্লায়েন্টকে পাঠান
                if (!res.headersSent) {
                    res.json({ qr: qr, status: 'qr_ready' });
                }
            }
            
            if (connection === 'open') {
                log(`✅ Session ${sessionId} connected!`);
                sessions.set(sessionId, sock);
                sock.ev.on('creds.update', saveCreds);
                
                // যদি রেসপন্স না দেওয়া হয়
                if (!res.headersSent && !qr) {
                    res.json({ status: 'connected', message: 'Connected successfully' });
                }
            }
            
            if (connection === 'close') {
                log(`❌ Session ${sessionId} disconnected`);
                sessions.delete(sessionId);
                
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    log(`Session ${sessionId} logged out`);
                }
            }
        });
        
    } catch (error) {
        log(`Error: ${error.message}`);
        clearTimeout(timeout);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// সেশন স্ট্যাটাস চেক
app.get('/session-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const connected = sessions.has(sessionId);
    res.json({ connected: connected });
});

// মেসেজ পাঠানো
app.post('/send-message', async (req, res) => {
    const { sessionId, number, message } = req.body;
    
    const sock = sessions.get(sessionId);
    if (!sock) {
        return res.status(404).json({ error: 'Session not found. Please connect WhatsApp first.' });
    }
    
    try {
        // নম্বর ফরম্যাট
        let formattedNumber = number.toString().replace(/[^0-9]/g, '');
        if (formattedNumber.startsWith('01')) {
            formattedNumber = '88' + formattedNumber;
        }
        if (!formattedNumber.endsWith('@c.us')) {
            formattedNumber = formattedNumber + '@c.us';
        }
        
        log(`Sending to: ${formattedNumber}`);
        await sock.sendMessage(formattedNumber, { text: message });
        
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        log(`Send error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ডিসকানেক্ট
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

// সার্ভার চালু
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    log(`🚀 Server running on port ${PORT}`);
});
