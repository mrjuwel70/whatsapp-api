const express = require('express');
const cors = require('cors');
const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
app.use(express.json());

// ========== MySQL ডাটাবেজ কনফিগারেশন ==========
// আপনার ইনফিনিটি ফ্রির ডাটাবেজ তথ্য দিন
const dbConfig = {
    host: 'sql100.infinityfree.com',
    user: 'if0_41668331',
    password: 'hPQQi9bLS7m',
    database: 'if0_41668331_whatsappapi_db'
};

let pool;

// ডাটাবেজ কানেক্ট করার ফাংশন
async function initDb() {
    pool = await mysql.createPool(dbConfig);
    console.log('✅ MySQL ডাটাবেজ কানেক্টেড');
}

// সেশন ডাটা সেভ করার ফাংশন
async function saveSession(sessionId, creds, keys = null) {
    const credsJson = JSON.stringify(creds);
    const keysJson = keys ? JSON.stringify(keys) : null;
    
    await pool.execute(
        `INSERT INTO whatsapp_sessions (session_id, creds, keys) 
         VALUES (?, ?, ?) 
         ON DUPLICATE KEY UPDATE 
         creds = VALUES(creds), 
         keys = VALUES(keys), 
         updated_at = CURRENT_TIMESTAMP`,
        [sessionId, credsJson, keysJson]
    );
    console.log(`💾 সেশন সংরক্ষিত: ${sessionId}`);
}

// সেশন ডাটা লোড করার ফাংশন
async function loadSession(sessionId) {
    const [rows] = await pool.execute(
        'SELECT creds, keys FROM whatsapp_sessions WHERE session_id = ?',
        [sessionId]
    );
    
    if (rows.length > 0) {
        console.log(`📂 সেশন লোড করা হয়েছে: ${sessionId}`);
        return {
            creds: JSON.parse(rows[0].creds),
            keys: rows[0].keys ? JSON.parse(rows[0].keys) : null
        };
    }
    return null;
}

// ========== WhatsApp সেশন ম্যানেজমেন্ট ==========
const sessions = new Map();

// সেশন তৈরি বা পুনরুদ্ধার
async function getOrCreateSession(sessionId) {
    if (sessions.has(sessionId)) {
        return sessions.get(sessionId);
    }
    
    // ডাটাবেজ থেকে আগের সেশন লোড করুন
    const savedSession = await loadSession(sessionId);
    
    // অথেন্টিকেশন স্টেট তৈরি
    let authState;
    if (savedSession) {
        authState = {
            creds: savedSession.creds,
            keys: savedSession.keys || {}
        };
    } else {
        authState = { creds: {}, keys: {} };
    }
    
    const sock = makeWASocket({
        auth: authState,
        printQRInTerminal: true,
        browser: ['WhatsApp API Gateway', 'Chrome', '1.0.0']
    });
    
    // ক্রেডেনশিয়াল আপডেট হলে ডাটাবেজে সেভ করুন
    sock.ev.on('creds.update', async (creds) => {
        await saveSession(sessionId, creds);
    });
    
    sessions.set(sessionId, sock);
    return sock;
}

// ========== API এন্ডপয়েন্ট ==========
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        message: 'WhatsApp API Server is running',
        sessions: sessions.size,
        database: 'connected'
    });
});

app.post('/create-session', async (req, res) => {
    const { sessionId } = req.body;
    console.log(`সেশন তৈরি রিকোয়েস্ট: ${sessionId}`);
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }
    
    // টাইমআউট সেট করুন
    const timeout = setTimeout(() => {
        if (!res.headersSent) {
            res.status(408).json({ error: 'QR generation timeout' });
        }
    }, 120000);
    
    try {
        const sock = await getOrCreateSession(sessionId);
        
        // QR কোডের জন্য অপেক্ষা করুন
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && !res.headersSent) {
                console.log(`✅ QR কোড জেনারেট হয়েছে ${sessionId}`);
                clearTimeout(timeout);
                res.json({ qr: qr, status: 'qr_ready' });
            }
            
            if (connection === 'open') {
                console.log(`✅ সেশন সংযুক্ত: ${sessionId}`);
                if (!res.headersSent) {
                    res.json({ status: 'connected', message: 'Already connected' });
                }
            }
            
            if (connection === 'close') {
                console.log(`❌ সেশন বিচ্ছিন্ন: ${sessionId}`);
                sessions.delete(sessionId);
                
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    // লগআউট হলে ডাটাবেজ থেকে ডিলিট করুন
                    await pool.execute('DELETE FROM whatsapp_sessions WHERE session_id = ?', [sessionId]);
                    console.log(`🗑️ সেশন ডিলিট: ${sessionId}`);
                }
            }
        });
        
    } catch (error) {
        console.error(`সেশন তৈরি ব্যর্থ: ${error.message}`);
        clearTimeout(timeout);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

app.get('/session-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const connected = sessions.has(sessionId);
    res.json({ connected: connected });
});

app.post('/send-message', async (req, res) => {
    const { sessionId, number, message } = req.body;
    console.log(`মেসেজ রিকোয়েস্ট: ${sessionId}, ${number}`);
    
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
        
        await sock.sendMessage(formattedNumber, { text: message });
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
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

// ========== সার্ভার চালু ==========
const PORT = process.env.PORT || 3000;

async function start() {
    await initDb();
    app.listen(PORT, () => {
        console.log(`🚀 সার্ভার চালু, পোর্ট: ${PORT}`);
    });
}

start();
