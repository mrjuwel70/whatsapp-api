const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// টেম্প ফোল্ডার Render-এ (সেশন সংরক্ষণের জন্য)
// Render ফ্রি টিয়ারে /tmp ফোল্ডার ব্যবহার করা যায়
const SESSIONS_DIR = '/tmp/whatsapp_sessions';

// ফোল্ডার তৈরি করুন
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    console.log(`📁 সেশন ফোল্ডার তৈরি: ${SESSIONS_DIR}`);
}

const sessions = new Map();

// লগ ফাংশন
function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

// হোম পেজ
app.get('/', (req, res) => {
    res.json({ 
        status: 'running', 
        message: 'WhatsApp API Server is running', 
        sessions: sessions.size,
        note: 'Using /tmp for sessions'
    });
});

// সেশন তৈরি
app.post('/create-session', async (req, res) => {
    const { sessionId } = req.body;
    log(`সেশন তৈরি রিকোয়েস্ট: ${sessionId}`);
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }
    
    // যদি ইতিমধ্যে সংযুক্ত থাকে
    if (sessions.has(sessionId)) {
        log(`সেশন ইতিমধ্যে সংযুক্ত: ${sessionId}`);
        return res.json({ message: 'Session already connected', status: 'connected' });
    }
    
    // টাইমআউট
    const timeout = setTimeout(() => {
        log(`সেশন টাইমআউট: ${sessionId}`);
        if (!res.headersSent) {
            res.status(408).json({ error: 'QR generation timeout' });
        }
    }, 120000);
    
    try {
        const authPath = path.join(SESSIONS_DIR, sessionId);
        log(`অথেন্টিকেশন পাথ: ${authPath}`);
        
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            browser: ['WhatsApp API Gateway', 'Chrome', '1.0.0']
        });
        
        // QR কোডের জন্য অপেক্ষা
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && !res.headersSent) {
                log(`✅ QR কোড জেনারেট হয়েছে ${sessionId}`);
                clearTimeout(timeout);
                res.json({ qr: qr, status: 'qr_ready' });
            }
            
            if (connection === 'open') {
                log(`✅ সেশন সংযুক্ত: ${sessionId}`);
                sessions.set(sessionId, sock);
                sock.ev.on('creds.update', saveCreds);
            }
            
            if (connection === 'close') {
                log(`❌ সেশন বিচ্ছিন্ন: ${sessionId}`);
                sessions.delete(sessionId);
                
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    log(`সেশন লগআউট হয়েছে: ${sessionId}`);
                    try {
                        fs.rmSync(authPath, { recursive: true, force: true });
                    } catch(e) {}
                }
            }
        });
        
    } catch (error) {
        log(`❌ সেশন তৈরি ব্যর্থ: ${error.message}`);
        clearTimeout(timeout);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// সেশন স্ট্যাটাস
app.get('/session-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const connected = sessions.has(sessionId);
    res.json({ connected: connected });
});

// মেসেজ পাঠানো
app.post('/send-message', async (req, res) => {
    const { sessionId, number, message } = req.body;
    log(`মেসেজ রিকোয়েস্ট: ${sessionId}, ${number}`);
    
    const sock = sessions.get(sessionId);
    if (!sock) {
        return res.status(404).json({ error: 'সেশন নেই। আগে WhatsApp কানেক্ট করুন।' });
    }
    
    try {
        let formattedNumber = number.toString().replace(/[^0-9]/g, '');
        if (formattedNumber.startsWith('01')) {
            formattedNumber = '88' + formattedNumber;
        }
        if (!formattedNumber.endsWith('@c.us')) {
            formattedNumber = formattedNumber + '@c.us';
        }
        
        log(`মেসেজ পাঠানো হচ্ছে: ${formattedNumber}`);
        await sock.sendMessage(formattedNumber, { text: message });
        
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        log(`❌ মেসেজ পাঠাতে পারেনি: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ডিসকানেক্ট
app.post('/disconnect', async (req, res) => {
    const { sessionId } = req.body;
    log(`ডিসকানেক্ট রিকোয়েস্ট: ${sessionId}`);
    
    if (sessions.has(sessionId)) {
        try {
            await sessions.get(sessionId).logout();
        } catch(e) {}
        sessions.delete(sessionId);
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

// সার্ভার চালু
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    log(`🚀 সার্ভার চালু হয়েছে, পোর্ট: ${PORT}`);
    log(`📁 সেশন ডিরেক্টরি: ${SESSIONS_DIR}`);
});
