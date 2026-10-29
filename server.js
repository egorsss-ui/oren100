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
const net = require('net');
const tls = require('tls');

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
const START_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):00$/; // «2026-10-29 14:00» — время по Москве

// ---------------- Расписание ----------------
// Репетиторы работают КАЖДЫЙ день с 14:00 до 21:00 по Москве. Занятие — 60 минут,
// поэтому последнее занятие начинается в 20:00. Меняйте значения здесь.
const TZ_OFFSET_H = 3;      // Москва = UTC+3 (без перехода на летнее время)
const WORK_START = 14;      // первое занятие начинается в 14:00
const WORK_END = 21;        // работа заканчивается в 21:00
const MIN_LEAD_MIN = 60;    // нельзя записаться на время, которое начнётся раньше чем через 60 минут
const HORIZON_DAYS = 7;     // запись открыта на 7 дней: сегодня + 6 следующих (одна неделя вперёд)
const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const pad2 = n => String(n).padStart(2, '0');
const mskNow = () => new Date(Date.now() + TZ_OFFSET_H * 3600e3); // читать только через getUTC*
const ymd = d => d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
const startToMs = start => { // момент начала занятия (UTC, мс)
  const m = START_RE.exec(start);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], 0) - TZ_OFFSET_H * 3600e3;
};
function slotLabel(start) { // «Чт, 29 окт 14:00»
  const m = START_RE.exec(start);
  const wd = WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  return wd + ', ' + Number(m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[4] + ':00';
}
function validStart(start) { // существует ли такая дата и входит ли время в рабочие часы
  const m = typeof start === 'string' && START_RE.exec(start);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (ymd(d) !== m[1] + '-' + m[2] + '-' + m[3]) return false;
  return +m[4] >= WORK_START && +m[4] < WORK_END;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONSENT_VERSION = '2026-10-29';   // версия текста согласия/политики; при смене текста обновите дату
const RESET_TTL = 60 * 60e3;            // ссылка восстановления пароля живёт 1 час
const MAX_RESCHEDULES = 3;              // сколько раз одну запись можно перенести
const DAY_MS = 86400e3;
const isDate = d => { const m = typeof d === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(d); return !!m && ymd(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))) === d; };

// ---------------- База данных (JSON-файл) ----------------
let db = { users: [], sessions: [], bookings: [], blocks: [], notes: [], resets: [] };

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    db = Object.assign({ users: [], sessions: [], bookings: [], blocks: [], notes: [], resets: [] }, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('Не удалось прочитать ' + DB_FILE + ': ' + e.message);
  }
  db.sessions = db.sessions.filter(s => s.exp > Date.now());
  ['blocks', 'notes', 'resets'].forEach(k => { if (!Array.isArray(db[k])) db[k] = []; });
  db.resets = db.resets.filter(r => r.exp > Date.now());
  migrateBookings();
}
// Старые записи хранили только текст «Ср, 23 окт 10:00» (без года). Достраиваем точную дату `start`.
function migrateBookings() {
  let changed = false;
  db.bookings.forEach(b => {
    if (b.start) return;
    const m = /(\d{1,2})\s+([а-я]{3})\s+(\d{2}):(\d{2})$/i.exec(b.slot || '');
    const mon = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
    if (!m || mon < 0) return;
    const year = new Date(b.createdAt || Date.now()).getUTCFullYear();
    b.start = year + '-' + pad2(mon + 1) + '-' + pad2(Number(m[1])) + ' ' + m[3] + ':' + m[4];
    const d = new Date(Date.UTC(year, mon, Number(m[1])));
    b.slot = WEEKDAYS[d.getUTCDay()] + ', ' + Number(m[1]) + ' ' + m[2].toLowerCase() + ' ' + m[3] + ':' + m[4]; // исправляем день недели
    changed = true;
  });
  if (changed) saveDb();
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
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, type: u.type, role: u.role, tutor: u.role === 'tutor' ? u.tutor || null : null, needsConsent: !u.consentAt });

// ---------------- Ограничение попыток ----------------
const attempts = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const arr = (attempts.get(key) || []).filter(t => now - t < windowMs);
  attempts.set(key, arr);
  return arr.length >= max;
}
const noteAttempt = key => attempts.set(key, [...(attempts.get(key) || []), Date.now()]);

// ---------------- Почта (восстановление пароля) ----------------
// Настройка через переменные окружения: SMTP_HOST, SMTP_PORT (465), SMTP_USER, SMTP_PASS, SMTP_FROM, SITE_URL.
// Без SMTP письма не отправляются: ссылка печатается в консоль сервера, а админ может выдать её в панели.
const SMTP = { host: process.env.SMTP_HOST || '', port: Number(process.env.SMTP_PORT) || 465, user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || '', secure: (process.env.SMTP_SECURE || 'ssl') !== 'none' };
function sendMail(to, subject, text) {
  return new Promise((resolve, reject) => {
    const sock = SMTP.secure ? tls.connect({ host: SMTP.host, port: SMTP.port, servername: SMTP.host }) : net.connect({ host: SMTP.host, port: SMTP.port });
    sock.setEncoding('utf8'); sock.setTimeout(20000, () => done(new Error('SMTP: таймаут')));
    let buf = '', step = 0, finished = false, waiting = null;
    const fromAddr = (/<([^>]+)>/.exec(SMTP.from) || [null, SMTP.from])[1];
    const b64 = t => Buffer.from(t, 'utf8').toString('base64');
    const body = b64(text).replace(/(.{76})/g, '$1\r\n');
    const msg = ['From: ' + SMTP.from, 'To: ' + to, 'Subject: =?UTF-8?B?' + b64(subject) + '?=', 'Date: ' + new Date().toUTCString(),
      'Message-ID: <' + crypto.randomBytes(12).toString('hex') + '@oren100>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64', '', body, '.', ''].join('\r\n');
    const cmds = [null, 'EHLO oren100'];
    if (SMTP.user) cmds.push('AUTH LOGIN', b64(SMTP.user), b64(SMTP.pass));
    cmds.push('MAIL FROM:<' + fromAddr + '>', 'RCPT TO:<' + to + '>', 'DATA', msg, 'QUIT');
    function done(err) { if (finished) return; finished = true; sock.destroy(); err ? reject(err) : resolve(); }
    sock.on('error', done);
    sock.on('close', () => done(step >= cmds.length ? null : new Error('SMTP: соединение закрыто')));
    sock.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^\d{3}-/.test(line)) continue; // продолжение многострочного ответа
        const code = Number(line.slice(0, 3));
        if (code >= 400) return done(new Error('SMTP: ' + line));
        step++;
        if (step >= cmds.length) return done(null);
        sock.write(cmds[step] + (cmds[step].endsWith('\r\n') ? '' : '\r\n'));
      }
    });
  });
}
function resetLink(req, token) {
  const base = (process.env.SITE_URL || ('http://' + (req.headers.host || 'localhost:' + PORT))).replace(/\/+$/, '');
  return base + '/reset.html?token=' + token;
}
function makeResetToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.resets = db.resets.filter(r => r.exp > Date.now() && r.userId !== userId);
  db.resets.push({ h: sha(token), userId, exp: Date.now() + RESET_TTL });
  saveDb();
  return token;
}
function deliverReset(req, user, token) {
  const link = resetLink(req, token);
  if (!SMTP.host || !process.env.SITE_URL) {
    if (SMTP.host) console.warn('Для отправки писем задайте SITE_URL (адрес сайта), иначе ссылка не отправляется по почте.');
    console.log('\n[Восстановление пароля] ' + user.email + '\n' + link + '\n');
    return;
  }
  sendMail(user.email, 'OREN100 — восстановление пароля',
    'Здравствуйте, ' + user.name + '!\n\nЧтобы задать новый пароль, перейдите по ссылке (действует 1 час):\n' + link +
    '\n\nЕсли вы не запрашивали восстановление, просто проигнорируйте это письмо — пароль не изменится.\n\nOREN100')
    .catch(e => console.error('Не удалось отправить письмо для ' + user.email + ': ' + e.message));
}

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
const studentKey = b => b.userId + '|' + String(b.student || '').toLowerCase().replace(/\s+/g, ' ').trim();
const isBlocked = (tutor, start) => {
  const date = start.slice(0, 10), h = Number(start.slice(11, 13));
  return db.blocks.some(k => k.tutor === tutor && date >= k.dateFrom && date <= k.dateTo && h >= k.fromHour && h < k.toHour);
};
const canChange = b => (b.status === 'new' || b.status === 'confirmed') && !!b.start && startToMs(b.start) - Date.now() >= DAY_MS;
function checkStart(start) { // время существует, в рабочих часах, не слишком скоро и не слишком далеко
  if (!validStart(start)) fail(400, 'Некорректное время занятия. Занятия проходят ежедневно с ' + WORK_START + ':00 до ' + WORK_END + ':00 по Москве.');
  if (startToMs(start) < Date.now() + MIN_LEAD_MIN * 60e3) fail(400, 'Это время уже прошло или начнётся слишком скоро. Выберите другое окошко.');
  const n = mskNow();
  const lastDay = ymd(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + HORIZON_DAYS - 1)));
  if (start.slice(0, 10) > lastDay) fail(400, 'Запись открыта только на ближайшую неделю (до ' + slotLabel(lastDay + ' 00:00').replace(/ 00:00$/, '') + ').');
}
function checkFree(tutor, start, ignoreId) { // репетитор принимает в это время и окошко не занято
  if (isBlocked(tutor, start)) fail(409, 'Репетитор в это время не принимает. Выберите другое окошко.');
  if (db.bookings.some(x => x.id !== ignoreId && activeBooking(x) && sameSlot(x, { tutor, start, slot: slotLabel(start) }))) fail(409, 'Это время уже занято. Выберите другое окошко.');
}
function applyStatus(bk, status, by) {
  if (!STATUSES.includes(status)) fail(400, 'Неизвестный статус');
  if (status !== 'cancelled' && bk.status === 'cancelled' && (isBlocked(bk.tutor, bk.start || '') ||
      db.bookings.some(x => x.id !== bk.id && sameSlot(x, bk) && activeBooking(x)))) fail(409, 'Это время уже занято или закрыто.');
  bk.status = status; bk.updatedAt = new Date().toISOString();
  if (status === 'cancelled') bk.cancelledBy = by; else delete bk.cancelledBy;
}
const sameSlot = (a, b) => a.tutor === b.tutor && (a.start && b.start ? a.start === b.start : a.slot === b.slot);

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
  const requireStaff = () => { requireUser(); if (me.role !== 'admin' && !(me.role === 'tutor' && hasTutor(me.tutor))) fail(403, 'Доступ только для репетиторов и администратора'); };
  // репетитор видит только себя; админ выбирает репетитора параметром
  const scopeTutor = t => { requireStaff(); if (me.role === 'tutor') return me.tutor; return hasTutor(t) ? t : fail(400, 'Выберите репетитора'); };

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
    if (b.consent !== true) fail(400, 'Для регистрации нужно согласие на обработку персональных данных.');
    if (db.users.some(u => u.email === email)) fail(409, 'Аккаунт с таким email уже существует. Попробуйте войти.');
    const nowIso = new Date().toISOString();
    const user = { id: nextId(db.users), name, email, phone, type, role: 'user', passwordHash: hashPassword(password), createdAt: nowIso, consentAt: nowIso, consentVersion: CONSENT_VERSION };
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

  // Восстановление пароля. Ответ всегда одинаковый — нельзя узнать, есть ли такой email.
  if (route === 'POST /api/forgot') {
    const b = await readBody(req);
    const email = str(b.email, 120).toLowerCase();
    if (!EMAIL_RE.test(email)) fail(400, 'Введите корректный email.');
    if (tooMany('forgot:' + ip, 6, 3600e3) || tooMany('forgotm:' + email, 3, 3600e3)) fail(429, 'Слишком много запросов. Попробуйте через час.');
    noteAttempt('forgot:' + ip); noteAttempt('forgotm:' + email);
    const user = db.users.find(u => u.email === email);
    if (user) deliverReset(req, user, makeResetToken(user.id));
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /api/reset') {
    if (tooMany('reset:' + ip, 20, 3600e3)) fail(429, 'Слишком много попыток. Попробуйте позже.');
    noteAttempt('reset:' + ip);
    const b = await readBody(req);
    const token = str(b.token, 100), password = typeof b.password === 'string' ? b.password : '';
    const r = token && db.resets.find(x => x.h === sha(token) && x.exp > Date.now());
    if (!r) fail(400, 'Ссылка недействительна или устарела. Запросите восстановление ещё раз.');
    if (password.length < 8 || password.length > 200) fail(400, 'Пароль должен быть не короче 8 символов.');
    const user = db.users.find(u => u.id === r.userId) || fail(400, 'Ссылка недействительна.');
    user.passwordHash = hashPassword(password);
    db.resets = db.resets.filter(x => x.userId !== user.id);
    db.sessions = db.sessions.filter(x => x.userId !== user.id); // все старые входы завершаются
    saveDb();
    return send(res, 200, { ok: true });
  }

  // Расписание репетитора: ближайшие дни от СЕГОДНЯШНЕЙ даты (по Москве), рабочие часы 14:00–21:00.
  // Занятые окошки приходят без персональных данных — видны всем.
  if (route === 'GET /api/schedule') {
    const tutor = url.searchParams.get('tutor');
    if (!hasTutor(tutor)) fail(400, 'Неизвестный репетитор');
    const now = mskNow();
    const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const busy = new Set(db.bookings.filter(b => b.tutor === tutor && activeBooking(b) && b.start).map(b => b.start));
    const minMs = Date.now() + MIN_LEAD_MIN * 60e3;
    const days = [];
    for (let i = 0; i < HORIZON_DAYS; i++) {
      const d = new Date(base + i * 86400e3), date = ymd(d), slots = [];
      for (let h = WORK_START; h < WORK_END; h++) {
        const start = date + ' ' + pad2(h) + ':00';
        slots.push({ time: pad2(h) + ':00', start, state: busy.has(start) ? 'busy' : isBlocked(tutor, start) ? 'closed' : (startToMs(start) < minMs ? 'past' : 'free') });
      }
      days.push({ date, weekday: WEEKDAYS[d.getUTCDay()], label: d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()], slots });
    }
    return send(res, 200, { today: ymd(now), timezone: 'МСК', days });
  }

  // Запись на занятие — только для вошедших пользователей
  if (route === 'POST /api/bookings') {
    requireUser();
    const b = await readBody(req);
    const tutor = hasTutor(b.tutor) ? b.tutor : fail(400, 'Неизвестный репетитор');
    const start = str(b.start, 20);
    checkStart(start);
    const slot = slotLabel(start);
    const student = str(b.student, 80), phone = str(b.phone, 30), email = str(b.email, 120), comment = str(b.comment, 500);
    const grade = Number(b.grade), subject = str(b.subject, 40), goal = str(b.goal, 60);
    if (student.length < 2) fail(400, 'Введите имя ученика.');
    if (phone.replace(/\D/g, '').length < 10) fail(400, 'Введите корректный телефон.');
    if (email && !EMAIL_RE.test(email)) fail(400, 'Введите корректный email.');
    if (!Number.isInteger(grade) || grade < 5 || grade > 11) fail(400, 'Выберите класс (с 5 по 11).');
    if (!TUTORS[tutor].subjects.includes(subject)) fail(400, 'Выберите предмет из списка.');
    if (!GOALS.includes(goal)) fail(400, 'Выберите цель занятий.');
    checkFree(tutor, start, null);
    const now = new Date().toISOString();
    if (!me.consentAt) { // аккаунты, созданные до появления согласия
      if (b.consent !== true) fail(400, 'Подтвердите согласие на обработку персональных данных.');
      me.consentAt = now; me.consentVersion = CONSENT_VERSION;
    }
    const booking = { id: nextId(db.bookings), userId: me.id, tutor, tutorName: TUTORS[tutor].name, slot, start, student, phone, email, grade, subject, goal, comment, status: 'new', createdAt: now, updatedAt: now };
    db.bookings.push(booking);
    saveDb();
    return send(res, 201, { booking });
  }

  // Мои записи — вся история, включая отменённые
  if (route === 'GET /api/bookings') {
    requireUser();
    return send(res, 200, { bookings: db.bookings.filter(b => b.userId === me.id).sort((a, b) => b.id - a.id).map(b => Object.assign({}, b, { editable: canChange(b), movesLeft: Math.max(0, MAX_RESCHEDULES - (b.moves || []).length) })) });
  }

  let m;
  if ((m = url.pathname.match(/^\/api\/bookings\/(\d+)\/cancel$/)) && req.method === 'POST') {
    requireUser();
    const bk = db.bookings.find(x => x.id === Number(m[1]) && x.userId === me.id) || fail(404, 'Запись не найдена');
    if (bk.status !== 'new' && bk.status !== 'confirmed') fail(409, 'Эту запись уже нельзя отменить.');
    // Время занятия (по Москве) хранится в bk.start — сравниваем с текущим моментом, год и часовой пояс учтены.
    if (bk.start && startToMs(bk.start) - Date.now() < 24 * 3600e3) fail(409, 'Отменить запись можно только не позднее чем за 24 часа до занятия.');
    bk.status = 'cancelled'; bk.cancelledBy = 'user'; bk.updatedAt = new Date().toISOString();
    saveDb();
    return send(res, 200, { booking: bk });
  }

  // Перенос записи одной операцией: время меняется у той же записи, данные ученика сохраняются
  if ((m = url.pathname.match(/^\/api\/bookings\/(\d+)\/reschedule$/)) && req.method === 'POST') {
    requireUser();
    const bk = db.bookings.find(x => x.id === Number(m[1]) && x.userId === me.id) || fail(404, 'Запись не найдена');
    if (bk.status !== 'new' && bk.status !== 'confirmed') fail(409, 'Эту запись уже нельзя перенести.');
    if (!bk.start) fail(409, 'Эту запись нельзя перенести автоматически. Оформите новую запись.');
    if (startToMs(bk.start) - Date.now() < DAY_MS) fail(409, 'Перенести запись можно только не позднее чем за 24 часа до занятия.');
    if ((bk.moves || []).length >= MAX_RESCHEDULES) fail(409, 'Запись уже переносили ' + MAX_RESCHEDULES + ' раза. Свяжитесь с репетитором.');
    const b = await readBody(req);
    const start = str(b.start, 20);
    checkStart(start);
    if (start === bk.start) fail(400, 'Выберите другое время.');
    checkFree(bk.tutor, start, bk.id);
    const now = new Date().toISOString();
    (bk.moves = bk.moves || []).push({ from: bk.start, fromSlot: bk.slot, at: now });
    bk.start = start; bk.slot = slotLabel(start); bk.updatedAt = now;
    if (bk.status === 'confirmed') bk.status = 'new'; // репетитор подтверждает новое время заново
    saveDb();
    return send(res, 200, { booking: Object.assign({}, bk, { editable: canChange(bk), movesLeft: Math.max(0, MAX_RESCHEDULES - bk.moves.length) }) });
  }

  // ---- Кабинет репетитора (репетитор — свои данные, администратор — любого) ----
  if (route === 'GET /api/staff/overview') {
    const tutor = scopeTutor(url.searchParams.get('tutor') || Object.keys(TUTORS)[0]);
    const tutors = {}; Object.keys(TUTORS).forEach(k => { if (me.role === 'admin' || k === tutor) tutors[k] = TUTORS[k].name; });
    const bookings = db.bookings.filter(b => b.tutor === tutor).sort((a, b) => (a.start || '').localeCompare(b.start || '')).map(b => {
      const u = db.users.find(x => x.id === b.userId);
      return Object.assign({}, b, { studentKey: studentKey(b), account: { name: u ? u.name : '—', email: u ? u.email : '', phone: u ? u.phone : '' } });
    });
    const n = mskNow();
    return send(res, 200, { tutor, tutorName: TUTORS[tutor].name, tutors, bookings,
      blocks: db.blocks.filter(k => k.tutor === tutor).sort((a, b) => a.dateFrom.localeCompare(b.dateFrom)),
      notes: db.notes.filter(x => x.tutor === tutor).sort((a, b) => b.id - a.id),
      today: ymd(n), now: ymd(n) + ' ' + pad2(n.getUTCHours()) + ':' + pad2(n.getUTCMinutes()), config: { workStart: WORK_START, workEnd: WORK_END } });
  }
  if ((m = url.pathname.match(/^\/api\/staff\/bookings\/(\d+)\/status$/)) && req.method === 'POST') {
    requireStaff();
    const b = await readBody(req);
    const bk = db.bookings.find(x => x.id === Number(m[1])) || fail(404, 'Запись не найдена');
    scopeTutor(bk.tutor); if (me.role === 'tutor' && bk.tutor !== me.tutor) fail(404, 'Запись не найдена');
    applyStatus(bk, b.status, me.role === 'admin' ? 'admin' : 'tutor');
    saveDb();
    return send(res, 200, { booking: bk });
  }
  // Закрытие времени: день, несколько дней (отпуск) или часть дня
  if (route === 'POST /api/staff/blocks') {
    const b = await readBody(req);
    const tutor = scopeTutor(b.tutor);
    const today = ymd(mskNow());
    let dateFrom = str(b.dateFrom, 10), dateTo = str(b.dateTo, 10) || dateFrom;
    if (!isDate(dateFrom) || !isDate(dateTo)) fail(400, 'Выберите дату.');
    if (dateTo < dateFrom) fail(400, 'Дата окончания раньше даты начала.');
    if (dateTo < today) fail(400, 'Нельзя закрыть время в прошлом.');
    if (dateFrom < today) dateFrom = today;
    if (Date.parse(dateTo) - Date.parse(dateFrom) > 366 * DAY_MS) fail(400, 'Слишком длинный период — не больше года.');
    const allDay = b.allDay === true;
    const fromHour = allDay ? WORK_START : Number(b.fromHour), toHour = allDay ? WORK_END : Number(b.toHour);
    if (!Number.isInteger(fromHour) || !Number.isInteger(toHour) || fromHour < WORK_START || toHour > WORK_END || fromHour >= toHour)
      fail(400, 'Выберите часы в пределах ' + WORK_START + ':00–' + WORK_END + ':00: «с» должно быть раньше «до».');
    const hit = db.bookings.filter(x => x.tutor === tutor && activeBooking(x) && x.start && startToMs(x.start) > Date.now() &&
      x.start.slice(0, 10) >= dateFrom && x.start.slice(0, 10) <= dateTo && Number(x.start.slice(11, 13)) >= fromHour && Number(x.start.slice(11, 13)) < toHour);
    if (hit.length && b.cancelConflicts !== true)
      return send(res, 409, { error: 'В закрываемое время уже есть записи: ' + hit.length + '. Их придётся отменить — ученики увидят, что запись отменена.', conflicts: hit.length });
    const now = new Date().toISOString();
    hit.forEach(x => { x.status = 'cancelled'; x.cancelledBy = me.role === 'admin' ? 'admin' : 'tutor'; x.updatedAt = now; });
    const block = { id: nextId(db.blocks), tutor, dateFrom, dateTo, fromHour, toHour, reason: str(b.reason, 120), createdBy: me.id, createdAt: now };
    db.blocks.push(block);
    saveDb();
    return send(res, 201, { block, cancelled: hit.length });
  }
  if ((m = url.pathname.match(/^\/api\/staff\/blocks\/(\d+)\/delete$/)) && req.method === 'POST') {
    requireStaff();
    const k = db.blocks.find(x => x.id === Number(m[1])) || fail(404, 'Не найдено');
    scopeTutor(k.tutor); if (me.role === 'tutor' && k.tutor !== me.tutor) fail(404, 'Не найдено');
    db.blocks = db.blocks.filter(x => x !== k);
    saveDb();
    return send(res, 200, { ok: true });
  }
  // Заметки об ученике (видны только репетитору и администратору)
  if (route === 'POST /api/staff/notes') {
    const b = await readBody(req);
    const tutor = scopeTutor(b.tutor);
    const mine = db.bookings.filter(x => x.tutor === tutor);
    const key = str(b.studentKey, 200);
    if (!mine.some(x => studentKey(x) === key)) fail(404, 'Ученик не найден');
    const text = str(b.text, 2000);
    if (!text) fail(400, 'Введите текст заметки.');
    let bookingId = null;
    if (b.bookingId != null) { const bk = mine.find(x => x.id === Number(b.bookingId) && studentKey(x) === key); if (!bk) fail(400, 'Занятие не найдено'); bookingId = bk.id; }
    const now = new Date().toISOString();
    const note = { id: nextId(db.notes), tutor, studentKey: key, bookingId, text, author: me.name, authorId: me.id, createdAt: now, updatedAt: now };
    db.notes.push(note); saveDb();
    return send(res, 201, { note });
  }
  if ((m = url.pathname.match(/^\/api\/staff\/notes\/(\d+)(\/delete)?$/)) && req.method === 'POST') {
    requireStaff();
    const note = db.notes.find(x => x.id === Number(m[1])) || fail(404, 'Заметка не найдена');
    scopeTutor(note.tutor); if (me.role === 'tutor' && note.tutor !== me.tutor) fail(404, 'Заметка не найдена');
    if (m[2]) { db.notes = db.notes.filter(x => x !== note); saveDb(); return send(res, 200, { ok: true }); }
    const text = str((await readBody(req)).text, 2000);
    if (!text) fail(400, 'Введите текст заметки.');
    note.text = text; note.updatedAt = new Date().toISOString(); saveDb();
    return send(res, 200, { note });
  }

  // ---- Администратор ----
  if (route === 'GET /api/admin/bookings') {
    requireAdmin();
    const bookings = db.bookings.slice().sort((a, b) => b.id - a.id).map(b => {
      const u = db.users.find(x => x.id === b.userId);
      return Object.assign({}, b, { account: { name: u ? u.name : '—', email: u ? u.email : '—' } });
    });
    const tutors = {}; Object.keys(TUTORS).forEach(k => { tutors[k] = TUTORS[k].name; });
    const n = mskNow();
    return send(res, 200, { bookings, today: ymd(n), now: ymd(n) + ' ' + pad2(n.getUTCHours()) + ':' + pad2(n.getUTCMinutes()), config: { workStart: WORK_START, workEnd: WORK_END, tutors } });
  }
  if (route === 'GET /api/admin/users') {
    requireAdmin();
    const users = db.users.slice().sort((a, b) => b.id - a.id).map(u => Object.assign(publicUser(u), { createdAt: u.createdAt, bookingsCount: db.bookings.filter(b => b.userId === u.id).length }));
    return send(res, 200, { users });
  }
  if ((m = url.pathname.match(/^\/api\/admin\/bookings\/(\d+)\/status$/)) && req.method === 'POST') {
    requireAdmin();
    const b = await readBody(req);
    const bk = db.bookings.find(x => x.id === Number(m[1])) || fail(404, 'Запись не найдена');
    applyStatus(bk, b.status, 'admin');
    saveDb();
    return send(res, 200, { booking: bk });
  }

  if ((m = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/role$/)) && req.method === 'POST') {
    requireAdmin();
    const b = await readBody(req);
    const u = db.users.find(x => x.id === Number(m[1])) || fail(404, 'Пользователь не найден');
    if (u.role === 'admin') fail(400, 'Роль администратора здесь не меняется.');
    if (b.role === 'tutor') { if (!hasTutor(b.tutor)) fail(400, 'Выберите репетитора.'); u.role = 'tutor'; u.tutor = b.tutor; }
    else if (b.role === 'user') { u.role = 'user'; delete u.tutor; }
    else fail(400, 'Неизвестная роль');
    saveDb();
    return send(res, 200, { user: publicUser(u) });
  }
  if ((m = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/reset-link$/)) && req.method === 'POST') {
    requireAdmin();
    const u = db.users.find(x => x.id === Number(m[1])) || fail(404, 'Пользователь не найден');
    return send(res, 200, { link: resetLink(req, makeResetToken(u.id)), email: u.email, validMinutes: RESET_TTL / 60e3 });
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
