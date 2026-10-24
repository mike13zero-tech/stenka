// Сервер игры «СТЕНКА»: раздаёт игру, проверяет вход через Telegram, хранит рейтинг.
// Рейтинг: в Postgres (DATABASE_URL, например Neon) — не пропадает при перезапусках.
// Если DATABASE_URL не задан, используется локальный файл data.json (только для тестов).
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
if (!TOKEN) { console.error('Задайте переменную окружения BOT_TOKEN'); process.exit(1); }

/* ---------- хранилище ---------- */
let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 10000 });
  pool.on('error', e => console.error('pg pool:', e.message));          // Neon усыпляет базу — не падаем
  const q = async (sql, params) => {
    try { return await pool.query(sql, params); }
    catch (e) { await new Promise(r => setTimeout(r, 800)); return pool.query(sql, params); } // одна повторная попытка (холодный старт базы)
  };
  const ready = q(`CREATE TABLE IF NOT EXISTS players (
    id BIGINT PRIMARY KEY, name TEXT NOT NULL, score INT NOT NULL DEFAULT 0, updated TIMESTAMPTZ NOT NULL DEFAULT now())`);
  store = {
    async save(id, name, score) {
      await ready;
      await q(`INSERT INTO players (id, name, score) VALUES ($1, $2, $3)
               ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
                 score = GREATEST(players.score, EXCLUDED.score),
                 updated = CASE WHEN EXCLUDED.score > players.score THEN now() ELSE players.updated END`, [id, name, score]);
    },
    async board(uid) {
      await ready;
      const top = (await q('SELECT id, name, score FROM players ORDER BY score DESC, updated ASC LIMIT 10')).rows
        .map(u => ({ name: u.name, score: u.score, me: String(u.id) === String(uid) }));
      const total = +(await q('SELECT COUNT(*) AS n FROM players')).rows[0].n;
      const m = (await q(`SELECT score, (SELECT COUNT(*) + 1 FROM players o WHERE o.score > p.score) AS rank
                          FROM players p WHERE id = $1`, [uid])).rows[0];
      return { top, total, me: m ? { rank: +m.rank, score: m.score } : null };
    }
  };
  console.log('Рейтинг хранится в Postgres');
} else {
  const DB = process.env.DB_FILE || path.join(__dirname, 'data.json');
  let db = {}; try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
  let saving = false;
  const flush = () => { if (saving) return; saving = true; setTimeout(() => { saving = false; fs.writeFile(DB, JSON.stringify(db), () => {}); }, 500); };
  store = {
    async save(id, name, score) { const c = db[id]; if (!c || score > c.score) db[id] = { name, score }; else c.name = name; flush(); },
    async board(uid) {
      const all = Object.entries(db).map(([id, u]) => ({ id, name: u.name, score: u.score })).sort((a, b) => b.score - a.score);
      const i = all.findIndex(u => u.id === String(uid));
      return { top: all.slice(0, 10).map(u => ({ name: u.name, score: u.score, me: u.id === String(uid) })), total: all.length, me: i >= 0 ? { rank: i + 1, score: all[i].score } : null };
    }
  };
  console.log('ВНИМАНИЕ: DATABASE_URL не задан, рейтинг хранится в data.json (на бесплатном Render он будет стираться)');
}

/* ---------- проверка входа через Telegram ---------- */
function check(initData) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash'); p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  if (crypto.createHmac('sha256', secret).update(str).digest('hex') !== hash) return null;
  if (Date.now() / 1000 - (+p.get('auth_date') || 0) > 3 * 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

/* ---------- API ---------- */
const app = express();
app.use(express.json({ limit: '10kb' }));
app.get('/health', (req, res) => res.send('ok'));   // для пинга, чтобы сервис не засыпал

app.post('/api/score', async (req, res) => {
  try {
    const user = check(req.body.initData);
    if (!user) return res.status(401).json({ error: 'auth' });
    const score = Math.max(0, Math.min(50000, Math.floor(+req.body.score || 0)));
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Игрок';
    await store.save(user.id, name, score);
    res.json(await store.board(user.id));
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

app.post('/api/leaderboard', async (req, res) => {
  try {
    const user = check(req.body.initData);
    if (!user) return res.status(401).json({ error: 'auth' });
    res.json(await store.board(user.id));
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', dotfiles: 'ignore' }));
app.listen(PORT, () => console.log('Игра запущена на порту ' + PORT));
