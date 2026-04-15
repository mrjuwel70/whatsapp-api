const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

// সেশনগুলো memory তে রাখা হবে
const sessions = new Map();

// হোম পেজ - চেক করার জন্য
app.get('/', (req, res) => {
    res.json({ 
        status: 'running', 
        message: 'WhatsApp API Server is running', 
        sessions: sessions.size 
    });
});

// সেশন তৈরি ও QR কোড জেনারেট
app.post('/create-session', async (req, res) => {
    const { sessionId } = req.body;
    console.log(`Session creation requested for: ${sessionId}`);
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }
    
    // যদি ইতিমধ্যে সেশন থাকে
    if (sessions.has(sessionId)) {
        return res.json({ message: 'Session already exists', qr: null });
    }
    
    // টাইমআউট সেট করুন (যদি ২ মিনিটের মধ্যে QR না আসে)
    const timeout = setTimeout(() => {
        console.log(`Session ${sessionId} timed out`);
        if (!res.headersSent) {
            res.status(408).json({ error: 'QR generation timeout' });
        }
    }, 120000);
    
    try {
        // অথেন্টিকেশন স্টেট লোড করুন
        const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${sessionId}`);
        
        // সকেট তৈরি করুন
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['WhatsApp API Gateway', 'Chrome', '1.0.0']
        });
        
        // সংযোগ আপডেট শুনুন
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log(`QR generated for ${sessionId}`);
                clearTimeout(timeout);
                
                // QR কোডটি ক্লায়েন্টকে পাঠান
                if (!res.headersSent) {
                    res.json({ qr: qr, status: 'qr_ready' });
                }
            }
            
            if (connection === 'open') {
                console.log(`✅ Session ${sessionId} connected successfully`);
                sessions.set(sessionId, sock);
                
                // ক্রেডেনশিয়াল সংরক্ষণ করুন
                sock.ev.on('creds.update', saveCreds);
            }
            
            if (connection === 'close') {
                console.log(`❌ Session ${sessionId} disconnected`);
                sessions.delete(sessionId);
            }
        });
        
    } catch (error) {
        console.error(`Error creating session ${sessionId}:`, error);
        clearTimeout(timeout);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// মেসেজ পাঠানোর এন্ডপয়েন্ট
app.post('/send-message', async (req, res) => {
    const { sessionId, number, message } = req.body;
    console.log(`Send message request: ${sessionId}, ${number}`);
    
    const sock = sessions.get(sessionId);
    if (!sock) {
        return res.status(404).json({ error: 'Session not found. Please connect WhatsApp first.' });
    }
    
    try {
        // নম্বর ফরম্যাট করুন
        let formattedNumber = number.toString().replace(/[^0-9]/g, '');
        if (formattedNumber.startsWith('01')) {
            formattedNumber = '88' + formattedNumber;
        }
        if (!formattedNumber.endsWith('@c.us')) {
            formattedNumber = formattedNumber + '@c.us';
        }
        
        console.log(`Sending message to: ${formattedNumber}`);
        await sock.sendMessage(formattedNumber, { text: message });
        
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ error: error.message });
    }
});

// সেশন স্ট্যাটাস চেক করুন
app.get('/session-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const connected = sessions.has(sessionId);
    res.json({ connected: connected });
});

// ডিসকানেক্ট করুন
app.post('/disconnect', async (req, res) => {
    const { sessionId } = req.body;
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

// সার্ভার চালু করুন
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 WhatsApp API Server running on port ${PORT}`);
});
