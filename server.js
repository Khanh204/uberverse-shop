const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const DB_PATH = path.join(__dirname, 'database.sqlite');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8347566306:AAE6k6nfnAnDitxp84euNneWNKvOnz5s_Sg';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8653472610';

function sendTelegramMessage(text, callback) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('❌ Chưa cấu hình TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID');
        if (callback) callback(false, 'Chưa cấu hình Token/Chat ID');
        return;
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const data = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'HTML'
    });

    const parsedUrl = new URL(url);
    const req = https.request({
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
            if (res.statusCode === 200) {
                console.log('✈️ Telegram: Gửi tin nhắn thành công!');
                if (callback) callback(true, body);
            } else {
                console.error(`❌ Telegram Lỗi [Code ${res.statusCode}]:`, body);
                if (callback) callback(false, body);
            }
        });
    });

    req.on('error', (e) => {
        console.error('❌ Lỗi kết nối Telegram:', e.message);
        if (callback) callback(false, e.message);
    });
    req.write(data);
    req.end();
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('Lỗi kết nối SQLite:', err.message);
    else console.log(`Đã kết nối SQLite tại: ${DB_PATH}`);
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT,
            password TEXT,
            token TEXT,
            uuid TEXT,
            rawData TEXT NOT NULL,
            banStart TEXT,
            banEnd TEXT NOT NULL,
            notified INTEGER DEFAULT 0,
            note TEXT,
            createdAt TEXT
        )
    `);
});

function parseRawLine(line) {
    if (!line || !line.trim()) return null;
    const cleanLine = line.trim();
    const parts = cleanLine.split('|');
    return {
        email: parts[0] ? parts[0].trim() : 'N/A',
        password: parts[1] ? parts[1].trim() : '',
        token: parts[2] ? parts[2].trim() : '',
        uuid: parts[3] ? parts[3].trim() : '',
        rawData: cleanLine
    };
}

// ROUTE TEST THÔNG BÁO TỨC THÌ: Truy cập http://localhost:3000/api/test-telegram
app.get('/api/test-telegram', (req, res) => {
    sendTelegramMessage('🔔 <b>TEST THÔNG BÁO TELEGRAM</b>\n\nKết nối Bot Telegram thành công!', (success, details) => {
        if (success) res.json({ status: 'Thành công', message: 'Đã gửi tin nhắn test về Telegram!' });
        else res.status(500).json({ status: 'Thất bại', error: details });
    });
});

app.get('/api/accounts', (req, res) => {
    db.all(`SELECT * FROM accounts ORDER BY banEnd ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => ({ ...r, notified: Boolean(r.notified) })));
    });
});

app.post('/api/accounts/bulk', (req, res) => {
    const { rawLines, banStart, banEnd, note } = req.body;
    if (!rawLines || typeof rawLines !== 'string') return res.status(400).json({ error: 'Dữ liệu không hợp lệ!' });

    const lines = rawLines.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return res.status(400).json({ error: 'Chưa nhập dòng dữ liệu nào!' });

    const nowIso = new Date().toISOString();
    const startIso = banStart ? new Date(banStart).toISOString() : nowIso;
    const endIso = banEnd ? new Date(banEnd).toISOString() : null;

    if (!endIso) return res.status(400).json({ error: 'Vui lòng chọn thời gian mở ban!' });

    const stmt = db.prepare(`
        INSERT INTO accounts (email, password, token, uuid, rawData, banStart, banEnd, notified, note, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);

    let addedCount = 0;
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        lines.forEach(line => {
            const parsed = parseRawLine(line);
            if (parsed) {
                stmt.run([parsed.email, parsed.password, parsed.token, parsed.uuid, parsed.rawData, startIso, endIso, note || '', nowIso]);
                addedCount++;
            }
        });
        db.run("COMMIT", (err) => {
            stmt.finalize();
            if (err) return res.status(500).json({ error: err.message });
            
            // Quét kiểm tra ngay sau khi thêm mới
            checkAndNotifyAccounts();
            res.json({ success: true, count: addedCount, message: `Thêm thành công ${addedCount} tài khoản!` });
        });
    });
});

app.post('/api/accounts/:id/notified', (req, res) => {
    db.run(`UPDATE accounts SET notified = 1 WHERE id = ?`, [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.put('/api/accounts/:id', (req, res) => {
    const { note, banEnd } = req.body;
    db.run(
        `UPDATE accounts SET note = COALESCE(?, note), banEnd = COALESCE(?, banEnd) WHERE id = ?`,
        [note, banEnd, req.params.id],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

app.delete('/api/accounts/:id', (req, res) => {
    db.run(`DELETE FROM accounts WHERE id = ?`, [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.post('/api/accounts/batch-delete', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Lỗi ID!' });
    const placeholders = ids.map(() => '?').join(',');
    db.run(`DELETE FROM accounts WHERE id IN (${placeholders})`, ids, function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, deletedCount: this.changes });
    });
});

// HÀM QUÉT & GỬI THÔNG BÁO
function checkAndNotifyAccounts() {
    const now = new Date().toISOString();
    
    // Tìm các tài khoản đã hết hạn ban (banEnd <= hiện tại) VÀ chưa báo (notified = 0)
    const sql = `SELECT * FROM accounts WHERE banEnd <= ? AND notified = 0`;

    db.all(sql, [now], (err, rows) => {
        if (err) {
            console.error('Lỗi truy vấn SQL:', err.message);
            return;
        }
        if (!rows || rows.length === 0) return;

        console.log(`🔔 Phát hiện ${rows.length} tài khoản cần báo Telegram...`);

        rows.forEach(acc => {
            const formattedDate = new Date(acc.banEnd).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
            
            const msg = `🎉 <b>TÀI KHOẢN ĐÃ ĐƯỢC MỞ BAN!</b>\n\n` +
                        `📧 <b>Email:</b> <code>${acc.email}</code>\n` +
                        `🔑 <b>Pass:</b> <code>${acc.password || 'N/A'}</code>\n` +
                        `🎟️ <b>Token:</b> <code>${acc.token || 'N/A'}</code>\n` +
                        `🆔 <b>UUID:</b> <code>${acc.uuid || 'N/A'}</code>\n` +
                        `⏰ <b>Mở ban lúc:</b> ${formattedDate}\n` +
                        `📝 <b>Ghi chú:</b> ${acc.note || 'Không'}\n\n` +
                        `📋 <b>Raw Data:</b>\n<code>${acc.rawData}</code>`;

            sendTelegramMessage(msg, (success) => {
                if (success) {
                    db.run(`UPDATE accounts SET notified = 1 WHERE id = ?`, [acc.id], (uErr) => {
                        if (!uErr) console.log(`✅ Đã đánh dấu notified=1 cho ID ${acc.id}`);
                    });
                }
            });
        });
    });
}

// Quét tự động định kỳ mỗi 15 giây
setInterval(checkAndNotifyAccounts, 15000);

app.listen(PORT, () => {
    console.log(`================================================`);
    console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`);
    console.log(`================================================`);
    
    // Chạy kiểm tra ngay khi vừa bật Server
    setTimeout(checkAndNotifyAccounts, 3000);
});