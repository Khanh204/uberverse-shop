const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Cấu hình đường dẫn lưu SQLite: Lưu trực tiếp tại thư mục chạy app
const DB_PATH = path.join(__dirname, 'database.sqlite');

// Đọc Token và Chat ID từ Environment Variables trên Render (hoặc dùng chuỗi mặc định nếu chạy local)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Hàm gửi tin nhắn qua Telegram Bot API
function sendTelegramMessage(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('Chưa cấu hình TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID');
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
    });

    req.on('error', (e) => console.error('Lỗi gửi Telegram:', e.message));
    req.write(data);
    req.end();
}

app.use(express.json());
app.use(express.static(__dirname));

// Kết nối cơ sở dữ liệu SQLite
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('Lỗi kết nối SQLite:', err.message);
    else console.log(`Đã kết nối thành công SQLite tại: ${DB_PATH}`);
});

// Khai báo bảng lưu dữ liệu tài khoản
db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT,
        rawData TEXT NOT NULL,
        banStart TEXT,
        banEnd TEXT NOT NULL,
        notified INTEGER DEFAULT 0
    )
`);

// TIẾN TRÌNH QUÉT NGẦM: Chạy tự động mỗi 30 giây để kiểm tra và gửi Telegram
setInterval(() => {
    const now = new Date().toISOString();
    const sql = `SELECT * FROM accounts WHERE banEnd <= ? AND notified = 0`;

    db.all(sql, [now], (err, rows) => {
        if (err || !rows || rows.length === 0) return;

        rows.forEach(acc => {
            const formattedDate = new Date(acc.banEnd).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
            
            // Nội dung tin nhắn gửi về Telegram
            const msg = `🎉 <b>TÀI KHOẢN ĐÃ ĐƯỢC MỞ BAN!</b>\n\n` +
                        `📧 <b>Email:</b> <code>${acc.email}</code>\n` +
                        `⏰ <b>Hạn mở ban:</b> ${formattedDate}\n\n` +
                        `📋 <b>Full Data:</b>\n<code>${acc.rawData}</code>`;

            // 1. Gửi tin nhắn đến điện thoại
            sendTelegramMessage(msg);

            // 2. Đánh dấu đã thông báo trong CSDL để tránh gửi lặp lại
            db.run(`UPDATE accounts SET notified = 1 WHERE id = ?`, [acc.id]);
        });
    });
}, 30000);

// API: Lấy danh sách toàn bộ tài khoản
app.get('/api/accounts', (req, res) => {
    db.all('SELECT * FROM accounts ORDER BY id DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => ({ ...r, notified: Boolean(r.notified) })));
    });
});

// API: Thêm tài khoản mới
app.post('/api/accounts', (req, res) => {
    const { rawData, banStart, banEnd } = req.body;
    if (!rawData || !banEnd) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc!' });

    const email = (rawData.split('|')[0] || 'Unknown').trim();
    const start = banStart || new Date().toISOString();

    db.run(`INSERT INTO accounts (email, rawData, banStart, banEnd, notified) VALUES (?, ?, ?, ?, 0)`, 
        [email, rawData.trim(), start, banEnd], 
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

// API: Đánh dấu đã thông báo thủ công (nếu cần)
app.post('/api/accounts/:id/notified', (req, res) => {
    db.run(`UPDATE accounts SET notified = 1 WHERE id = ?`, [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// API: Xóa tài khoản
app.delete('/api/accounts/:id', (req, res) => {
    db.run(`DELETE FROM accounts WHERE id = ?`, [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.listen(PORT, () => {
    console.log(`Server đang hoạt động tại cổng: ${PORT}`);
});