const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'database.sqlite');

// Middlewares xử lý JSON và Static Files
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Lỗi khi kết nối cơ sở dữ liệu SQLite:', err.message);
    } else {
        console.log('-> Kết nối SQLite Database thành công!');
    }
});

// Tạo bảng tài khoản đầy đủ các trường thông tin nâng cao
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

// Hàm phân tích cú pháp tự động từ chuỗi raw Email|Pass|Token|UUID
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


// API 1: Lấy danh sách tài khoản
app.get('/api/accounts', (req, res) => {
    const sql = `SELECT * FROM accounts ORDER BY banEnd ASC`;
    db.all(sql, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Lỗi truy vấn cơ sở dữ liệu: ' + err.message });
        }
        const formatted = rows.map(r => ({
            ...r,
            notified: Boolean(r.notified)
        }));
        res.json(formatted);
    });
});

// API 2: Nhập hàng loạt tài khoản (Bulk Add)
app.post('/api/accounts/bulk', (req, res) => {
    const { rawLines, banStart, banEnd, hoursToAdd, note } = req.body;

    if (!rawLines || typeof rawLines !== 'string') {
        return res.status(400).json({ error: 'Dữ liệu tài khoản không hợp lệ!' });
    }

    const lines = rawLines.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) {
        return res.status(400).json({ error: 'Không tìm thấy dòng dữ liệu nào!' });
    }

    const nowIso = new Date().toISOString();
    const startIso = banStart ? new Date(banStart).toISOString() : nowIso;

    // Tính toán ngày mở ban nếu người dùng truyền số giờ thay vì datetime cụ thể
    let endIso = banEnd ? new Date(banEnd).toISOString() : null;
    if (!endIso && hoursToAdd) {
        const endDate = new Date(new Date(startIso).getTime() + parseFloat(hoursToAdd) * 3600 * 1000);
        endIso = endDate.toISOString();
    }

    if (!endIso) {
        return res.status(400).json({ error: 'Vui lòng cung cấp ngày mở ban hoặc khoảng thời gian ban!' });
    }

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
                stmt.run([
                    parsed.email,
                    parsed.password,
                    parsed.token,
                    parsed.uuid,
                    parsed.rawData,
                    startIso,
                    endIso,
                    note || '',
                    nowIso
                ]);
                addedCount++;
            }
        });
        db.run("COMMIT", (err) => {
            stmt.finalize();
            if (err) {
                return res.status(500).json({ error: 'Lỗi khi lưu dữ liệu hàng loạt: ' + err.message });
            }
            res.json({ success: true, count: addedCount, message: `Thêm thành công ${addedCount} tài khoản!` });
        });
    });
});


// API 3: Đánh dấu đã phát thông báo
app.post('/api/accounts/:id/notified', (req, res) => {
    const { id } = req.params;
    db.run(`UPDATE accounts SET notified = 1 WHERE id = ?`, [id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// API 4: Cập nhật ghi chú hoặc thời gian ban
app.put('/api/accounts/:id', (req, res) => {
    const { id } = req.params;
    const { note, banEnd } = req.body;
    db.run(
        `UPDATE accounts SET note = COALESCE(?, note), banEnd = COALESCE(?, banEnd) WHERE id = ?`,
        [note, banEnd, id],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// API 5: Xóa đơn lẻ
app.delete('/api/accounts/:id', (req, res) => {
    const { id } = req.params;
    db.run(`DELETE FROM accounts WHERE id = ?`, [id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// API 6: Xóa hàng loạt
app.post('/api/accounts/batch-delete', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'Danh sách ID không hợp lệ!' });
    }
    const placeholders = ids.map(() => '?').join(',');
    db.run(`DELETE FROM accounts WHERE id IN (${placeholders})`, ids, function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, deletedCount: this.changes });
    });
});

app.listen(PORT, () => {
    console.log(`================================================`);
    console.log(`🚀 Ban Account Manager Pro đang khởi chạy!`);
    console.log(`🌐 Truy cập đường dẫn: http://localhost:${PORT}`);
    console.log(`================================================`);
});