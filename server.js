'use strict';
/**
 * OREN100 — сервер сайта репетиторов.
 * Без внешних зависимостей: только встроенные модули Node.js (18+).
 * Данные хранятся в data/db.json (пользователи, сессии, ВСЕ записи, включая отменённые).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const COOKIE = 'oren_sid';

const TUTORS = {
  egor: { name: 'Егор Артемович', subjects: ['Математика', 'Информатика'] },
  valentina: { name: 'Валентина Александровна', subjects: ['Математика', 'Информатика'] },
};
const GOALS = ['ВПР', 'МЦКО', 'ОГЭ', 'ЕГЭ', 'Повышение успеваемости', 'Помощь с домашним заданием'];
const STATUSES = ['new', 'confirmed', 'done', 'cancelled'];
const SLOT_RE = /^(Пн|Вт|Ср|Чт|Пт|Сб|Вс), \d{1,2} [а-я]{3} \d{2}:\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------- База данных (JSON-файл) ----------------
let db = { users: [], sessions: [], bookings: [] };

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    db = Object.assign({ users: [], sessions: [], bookings: [] }, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('Не удалось прочитать ' + DB_FILE + ': ' + e.message);
  }
  db.sessions = db.sessions.filter(s => s.exp > Date.now());
}
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE); // атомарная запись: файл не повредится при сбое
}
const hasTutor = t => typeof t === 'string' && Object.prototype.hasOwnProperty.call(TUTORS, t);
const nextId = arr => arr.reduce((m, x) => Math.max(m, x.id), 0) + 1;

// ---------------- Пароли и сессии ----------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  const [s, h] = stored.split(':');
  const a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function cookieFlags(req) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return 'Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
}
function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions = db.sessions.filter(s => s.exp > Date.now());
  db.sessions.push({ h: sha(token), userId, exp: Date.now() + SESSION_TTL });
  saveDb();
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Max-Age=${SESSION_TTL / 1000}; ${cookieFlags(req)}`);
}
function endSession(req, res) {
  const t = parseCookies(req)[COOKIE];
  if (t) { db.sessions = db.sessions.filter(s => s.h !== sha(t)); saveDb(); }
  res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags(req)}`);
}
function currentUser(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const s = db.sessions.find(x => x.h === sha(t) && x.exp > Date.now());
  return s ? db.users.find(u => u.id === s.userId) || null : null;
}
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, type: u.type, role: u.role });

// ---------------- Ограничение попыток ----------------
const attempts = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const arr = (attempts.get(key) || []).filter(t => now - t < windowMs);
  attempts.set(key, arr);
  return arr.length >= max;
}
const noteAttempt = key => attempts.set(key, [...(attempts.get(key) || []), Date.now()]);

// ---------------- Утилиты HTTP ----------------
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 100 * 1024) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch (e) { reject(new HttpError(400, 'Некорректные данные')); }
    });
    req.on('error', reject);
  });
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------------- API ----------------
const activeBooking = b => b.status !== 'cancelled';

async function handleApi(req, res, url) {
  const route = req.method + ' ' + url.pathname;

  // Защита от CSRF: изменяющие запросы только JSON и только со своего сайта
  if (req.method !== 'GET') {
    if (!(req.headers['content-type'] || '').includes('application/json')) fail(415, 'Неверный формат запроса');
    const origin = req.headers.origin;
    if (origin) { let h = ''; try { h = new URL(origin).host; } catch (e) {} if (h !== req.headers.host) fail(403, 'Запрос отклонён'); }
  }
  const ip = req.socket.remoteAddress || 'ip';
  const me = currentUser(req);
  const requireUser = () => me || fail(401, 'Войдите в аккаунт, чтобы продолжить');
  const requireAdmin = () => { requireUser(); if (me.role !== 'admin') fail(403, 'Доступ только для администратора'); };

  if (route === 'GET /api/me') return send(res, 200, { user: me ? publicUser(me) : null });

  if (route === 'POST /api/register') {
    if (tooMany('reg:' + ip, 10, 3600e3)) fail(429, 'Слишком много попыток. Попробуйте позже.');
    noteAttempt('reg:' + ip);
    const b = await readBody(req);
    const name = str(b.name, 80), phone = str(b.phone, 30), email = str(b.email, 120).toLowerCase();
    const password = typeof b.password === 'string' ? b.password : '';
    const type = b.type === 'student' ? 'student' : 'parent';
    if (name.length < 2) fail(400, 'Введите имя.');
    if (phone.replace(/\D/g, '').length < 10) fail(400, 'Введите корректный телефон.');
    if (!EMAIL_RE.test(email)) fail(400, 'Введите корректный email.');
    if (password.length < 8 || password.length > 200) fail(400, 'Пароль должен быть не короче 8 символов.');
    if (db.users.some(u => u.email === email)) fail(409, 'Аккаунт с таким email уже существует. Попробуйте войти.');
    const user = { id: nextId(db.users), name, email, phone, type, role: 'user', passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    db.users.push(user);
    startSession(req, res, user.id); // saveDb внутри
    return send(res, 201, { user: publicUser(user) });
  }

  if (route === 'POST /api/login') {
    const b = await readBody(req);
    const email = str(b.email, 120).toLowerCase(), password = typeof b.password === 'string' ? b.password : '';
    const key = 'login:' + ip + ':' + email;
    if (tooMany(key, 8, 15 * 60e3)) fail(429, 'Слишком много неудачных попыток. Подождите 15 минут.');
    const user = db.users.find(u => u.email === email);
    if (!user || password.length > 200 || !verifyPassword(password, user.passwordHash)) { noteAttempt(key); fail(401, 'Неверный email или пароль.'); }
    attempts.delete(key);
    startSession(req, res, user.id);
    return send(res, 200, { user: publicUser(user) });
  }

  if (route === 'POST /api/logout') { endSession(req, res); return send(res, 200, { ok: true }); }

  // Занятые окошки репетитора (без персональных данных) — видны всем
  if (route === 'GET /api/slots') {
    const tutor = url.searchParams.get('tutor');
    if (!hasTutor(tutor)) fail(400, 'Неизвестный репетитор');
    return send(res, 200, { taken: db.bookings.filter(b => b.tutor === tutor && activeBooking(b)).map(b => b.slot) });
  }

  // Запись на занятие — только для вошедших пользователей
  if (route === 'POST /api/bookings') {
    requireUser();
    const b = await readBody(req);
    const tutor = hasTutor(b.tutor) ? b.tutor : fail(400, 'Неизвестный репетитор');
    const slot = str(b.slot, 40);
    if (!SLOT_RE.test(slot)) fail(400, 'Некорректное время занятия.');
    const student = str(b.student, 80), phone = str(b.phone, 30), email = str(b.email, 120), comment = str(b.comment, 500);
    const grade = Number(b.grade), subject = str(b.subject, 40), goal = str(b.goal, 60);
    if (student.length < 2) fail(400, 'Введите имя ученика.');
    if (phone.replace(/\D/g, '').length < 10) fail(400, 'Введите корректный телефон.');
    if (email && !EMAIL_RE.test(email)) fail(400, 'Введите корректный email.');
    if (!Number.isInteger(grade) || grade < 5 || grade > 11) fail(400, 'Выберите класс (с 5 по 11).');
    if (!TUTORS[tutor].subjects.includes(subject)) fail(400, 'Выберите предмет из списка.');
    if (!GOALS.includes(goal)) fail(400, 'Выберите цель занятий.');
    if (db.bookings.some(x => x.tutor === tutor && x.slot === slot && activeBooking(x))) fail(409, 'Это время уже занято. Выберите другое окошко.');
    const now = new Date().toISOString();
    const booking = { id: nextId(db.bookings), userId: me.id, tutor, tutorName: TUTORS[tutor].name, slot, student, phone, email, grade, subject, goal, comment, status: 'new', createdAt: now, updatedAt: now };
    db.bookings.push(booking);
    saveDb();
    return send(res, 201, { booking });
  }

  // Мои записи — вся история, включая отменённые
  if (route === 'GET /api/bookings') {
    requireUser();
    return send(res, 200, { bookings: db.bookings.filter(b => b.userId === me.id).sort((a, b) => b.id - a.id) });
  }

  let m;
  if ((m = url.pathname.match(/^\/api\/bookings\/(\d+)\/cancel$/)) && req.method === 'POST') {
    requireUser();
    const bk = db.bookings.find(x => x.id === Number(m[1]) && x.userId === me.id) || fail(404, 'Запись не найдена');
    if (bk.status !== 'new' && bk.status !== 'confirmed') fail(409, 'Эту запись уже нельзя отменить.');
    // Время занятия хранится в формате «Пн, 21 окт 09:00» без года.
    const months = { 'янв': 0, 'фев': 1, 'мар': 2, 'апр': 3, 'май': 4, 'июн': 5, 'июл': 6, 'авг': 7, 'сен': 8, 'окт': 9, 'ноя': 10, 'дек': 11 };
    const sm = bk.slot.match(/,\s*(\d{1,2})\s+([а-я]{3})\s+(\d{2}):(\d{2})$/i);
    if (sm) {
      const now = new Date();
      let lesson = new Date(now.getFullYear(), months[sm[2].toLowerCase()], Number(sm[1]), Number(sm[3]), Number(sm[4]));
      if (lesson.getTime() < now.getTime() - 180 * 24 * 3600 * 1000) lesson.setFullYear(lesson.getFullYear() + 1);
      if (lesson.getTime() - now.getTime() < 24 * 3600 * 1000) fail(409, 'Отменить запись можно только не позднее чем за 24 часа до занятия.');
    }
    bk.status = 'cancelled'; bk.cancelledBy = 'user'; bk.updatedAt = new Date().toISOString();
    saveDb();
    return send(res, 200, { booking: bk });
  }

  // ---- Администратор ----
  if (route === 'GET /api/admin/bookings') {
    requireAdmin();
    const bookings = db.bookings.slice().sort((a, b) => b.id - a.id).map(b => {
      const u = db.users.find(x => x.id === b.userId);
      return Object.assign({}, b, { account: { name: u ? u.name : '—', email: u ? u.email : '—' } });
    });
    return send(res, 200, { bookings });
  }
  if (route === 'GET /api/admin/users') {
    requireAdmin();
    const users = db.users.slice().sort((a, b) => b.id - a.id).map(u => Object.assign(publicUser(u), { createdAt: u.createdAt, bookingsCount: db.bookings.filter(b => b.userId === u.id).length }));
    return send(res, 200, { users });
  }
  if ((m = url.pathname.match(/^\/api\/admin\/bookings\/(\d+)\/status$/)) && req.method === 'POST') {
    requireAdmin();
    const b = await readBody(req);
    if (!STATUSES.includes(b.status)) fail(400, 'Неизвестный статус');
    const bk = db.bookings.find(x => x.id === Number(m[1])) || fail(404, 'Запись не найдена');
    if (b.status !== 'cancelled' && bk.status === 'cancelled' &&
        db.bookings.some(x => x.id !== bk.id && x.tutor === bk.tutor && x.slot === bk.slot && activeBooking(x))) fail(409, 'Это время уже занято другой записью.');
    bk.status = b.status; bk.updatedAt = new Date().toISOString();
    if (b.status === 'cancelled') bk.cancelledBy = 'admin'; else delete bk.cancelledBy;
    saveDb();
    return send(res, 200, { booking: bk });
  }

  fail(404, 'Не найдено');
}

// ---------------- Статические файлы ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp' };
const CSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

function serveStatic(req, res, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Страница не найдена'); }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };
    if (ext === '.html') { headers['Content-Security-Policy'] = CSP; headers['X-Frame-Options'] = 'DENY'; headers['Referrer-Policy'] = 'same-origin'; }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------- Запуск ----------------
function ensureAdmin() {
  const envEmail = process.env.ADMIN_EMAIL && process.env.ADMIN_EMAIL.trim().toLowerCase();
  const envPw = process.env.ADMIN_PASSWORD;
  let admin = db.users.find(u => u.role === 'admin');
  if (!admin) {
    const email = envEmail || 'admin@oren100.local';
    const pw = envPw || crypto.randomBytes(9).toString('base64url');
    admin = { id: nextId(db.users), name: 'Администратор', email, phone: '', type: 'parent', role: 'admin', passwordHash: hashPassword(pw), createdAt: new Date().toISOString() };
    db.users.push(admin); saveDb();
    console.log('\n=== Создан администратор ===');
    console.log('Email:   ' + email);
    console.log('Пароль:  ' + (envPw ? '(из ADMIN_PASSWORD)' : pw + '   <- сохраните, он показывается один раз'));
    console.log('Вход:    http://localhost:' + PORT + '/login.html\n');
  } else if (envPw || envEmail) {
    if (envPw) admin.passwordHash = hashPassword(envPw);
    if (envEmail && !db.users.some(u => u.email === envEmail && u.id !== admin.id)) admin.email = envEmail;
    saveDb();
    console.log('Данные администратора обновлены из переменных окружения.');
  }
}

loadDb();
ensureAdmin();

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url.pathname);
    else { res.writeHead(405); res.end('Method not allowed'); }
  } catch (e) {
    if (e instanceof HttpError) { if (!res.headersSent) send(res, e.status, { error: e.message }); }
    else { console.error(e); if (!res.headersSent) send(res, 500, { error: 'Внутренняя ошибка сервера' }); }
  }
}).listen(PORT, () => console.log('OREN100 запущен: http://localhost:' + PORT));
