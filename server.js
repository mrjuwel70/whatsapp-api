// server.js - WhatsApp ব্যাকএন্ড সার্ভার
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// মিডলওয়্যার
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// সেশন স্টোর করার জন্য
const sessions = new Map();
const qrQueues = new Map();

// সেশন ফোল্ডার তৈরি (যদি না থাকে)
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir);
}

// হেলথ চেক এন্ডপয়েন্ট
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        message: 'WhatsApp API Server is running',
        sessions: sessions.size,
        timestamp: new Date().toISOString()
    });
});

// সেশন স্ট্যাটাস চেক
app.get('/session-status/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const isConnected = sessions.has(sessionId);
    res.json({ 
        connected: isConnected,
        sessionId: sessionId,
        timestamp: new Date().toISOString()
    });
});

// সেশন তৈরি করার এন্ডপয়েন্ট
app.post('/create-session', async (req, res) => {
    const { sessionId } = req.body;
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }
    
    // যদি আগের সেশন থাকে, ডিলিট করুন
    if (sessions.has(sessionId)) {
        sessions.delete(sessionId);
    }
    
    // সেট টাইমআউট যাতে QR 2 মিনিটের মধ্যে না এলে timeout হয়
    const timeout = setTimeout(() => {
        if (qrQueues.has(sessionId)) {
            qrQueues.delete(sessionId);
            res.status(408).json({ error: 'QR generation timeout' });
        }
    }, 120000);
    
    try {
        const authPath = path.join(sessionsDir, sessionId);
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['WhatsApp API Gateway', 'Chrome', '1.0.0']
        });
        
        // সংযোগ আপডেট ইভেন্ট
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log(`QR generated for ${sessionId}`);
                // QR কোডকে Base64 ইমেজে কনভার্ট
                const qrBuffer = await QRCode.toBuffer(qr);
                const qrBase64 = qrBuffer.toString('base64');
                
                if (qrQueues.has(sessionId)) {
                    // ইতিমধ্যে রেসপন্স দেওয়া হয়ে থাকলে
                    return;
                }
                
                qrQueues.set(sessionId, true);
                clearTimeout(timeout);
                
                res.json({
                    status: 'qr_ready',
                    qr: qr,
                    qr_base64: qrBase64,
                    sessionId: sessionId
                });
            }
            
            if (connection === 'open') {
                console.log(`✅ Session ${sessionId} connected!`);
                sessions.set(sessionId, sock);
                
                // সেশন ডাটা সেভ করা
                sock.ev.on('creds.update', saveCreds);
            }
            
            if (connection === 'close') {
                console.log(`❌ Session ${sessionId} disconnected`);
                sessions.delete(sessionId);
                
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(`Session ${sessionId} logged out. Need to re-login.`);
                    // লগআউট হলে সেশন ফোল্ডার ডিলিট
                    fs.rmSync(authPath, { recursive: true, force: true });
                }
            }
        });
        
        // মেসেজ রিসিভ করার ইভেন্ট (অপশনাল)
        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.key.fromMe && msg.message) {
                console.log(`📨 Received message from: ${msg.key.remoteJid}`);
                // এখানে চাইলে ওয়েবহুক কল করতে পারেন
            }
        });
        
    } catch (error) {
        console.error(`Error creating session ${sessionId}:`, error);
        clearTimeout(timeout);
        res.status(500).json({ error: error.message });
    }
});

// মেসেজ পাঠানোর এন্ডপয়েন্ট
app.post('/send-message', async (req, res) => {
    const { sessionId, number, message } = req.body;
    
    if (!sessionId || !number || !message) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing required parameters: sessionId, number, message' 
        });
    }
    
    const sock = sessions.get(sessionId);
    
    if (!sock) {
        return res.status(404).json({ 
            success: false, 
            error: 'Session not found or disconnected. Please reconnect WhatsApp.' 
        });
    }
    
    try {
        // নম্বর ফরম্যাট করা
        let formattedNumber = number.toString().replace(/[^0-9]/g, '');
        
        // বাংলাদেশি নম্বর ফরম্যাট
        if (formattedNumber.startsWith('01')) {
            formattedNumber = '88' + formattedNumber;
        }
        if (!formattedNumber.endsWith('@c.us')) {
            formattedNumber = formattedNumber + '@c.us';
        }
        
        console.log(`📤 Sending message to: ${formattedNumber}`);
        
        // মেসেজ পাঠানো
        const result = await sock.sendMessage(formattedNumber, { text: message });
        
        res.json({
            success: true,
            message: 'Message sent successfully',
            messageId: result.key.id,
            to: number,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error(`Error sending message:`, error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// একাধিক মেসেজ পাঠানোর এন্ডপয়েন্ট (বাল্ক)
app.post('/send-bulk', async (req, res) => {
    const { sessionId, messages } = req.body;
    
    if (!sessionId || !messages || !Array.isArray(messages)) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing required parameters: sessionId, messages array' 
        });
    }
    
    const sock = sessions.get(sessionId);
    
    if (!sock) {
        return res.status(404).json({ 
            success: false, 
            error: 'Session not found' 
        });
    }
    
    const results = [];
    let successCount = 0;
    let failCount = 0;
    
    for (const msg of messages) {
        try {
            let formattedNumber = msg.number.toString().replace(/[^0-9]/g, '');
            if (formattedNumber.startsWith('01')) {
                formattedNumber = '88' + formattedNumber;
            }
            if (!formattedNumber.endsWith('@c.us')) {
                formattedNumber = formattedNumber + '@c.us';
            }
            
            const result = await sock.sendMessage(formattedNumber, { text: msg.message });
            successCount++;
            results.push({ number: msg.number, success: true, messageId: result.key.id });
            
            // রেট লিমিট এড়াতে 1 সেকেন্ড অপেক্ষা
            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (error) {
            failCount++;
            results.push({ number: msg.number, success: false, error: error.message });
        }
    }
    
    res.json({
        success: true,
        total: messages.length,
        successCount: successCount,
        failCount: failCount,
        results: results
    });
});

// ডিসকানেক্ট করার এন্ডপয়েন্ট
app.post('/disconnect', async (req, res) => {
    const { sessionId } = req.body;
    
    if (sessions.has(sessionId)) {
        const sock = sessions.get(sessionId);
        await sock.logout();
        sessions.delete(sessionId);
        res.json({ success: true, message: 'Disconnected successfully' });
    } else {
        res.json({ success: false, message: 'Session not found' });
    }
});

// সার্ভার চালু করা
app.listen(PORT, () => {
    console.log(`🚀 WhatsApp API Server running on port ${PORT}`);
    console.log(`📱 Ready to accept connections`);
    console.log(`📍 Health check: http://localhost:${PORT}/`);
});
