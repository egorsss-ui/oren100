document.addEventListener('DOMContentLoaded', async () => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const STATUS = { new: 'Ожидает подтверждения', confirmed: 'Подтверждена', done: 'Проведено', cancelled: 'Отменена' };
  const TUTOR_NAMES = { egor: 'Егор Артемович', valentina: 'Валентина Александровна' };
  let user = null;

  // Год в подвале обновляется сам
  $$('.year').forEach(y => { y.textContent = new Date().getFullYear(); });

  // ---------- Запросы к серверу ----------
  async function api(url, opts = {}) {
    const method = opts.method || 'GET';
    const init = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body || {}); }
    let res;
    try { res = await fetch(url, init); }
    catch (e) { const err = new Error('Нет связи с сервером. Проверьте, что сервер запущен.'); err.status = 0; throw err; }
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) { const err = new Error(data.error || 'Ошибка сервера'); err.status = res.status; throw err; }
    return data;
  }
  const fmtDate = iso => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const nextParam = () => { const n = new URLSearchParams(location.search).get('next'); return n && /^[\w-]+\.html$/.test(n) ? n : null; };
  const thisPage = () => location.pathname.split('/').pop() || 'index.html';

  // ---------- Главная: фильтр репетиторов (не зависит от входа) ----------
  const filters = $$('.filter[data-f]');
  const apply = f => {
    filters.forEach(x => x.classList.toggle('active', x.dataset.f === f));
    $$('.tutor-card').forEach(c => { c.hidden = !(f === 'all' || c.dataset.subj.split(' ').includes(f)); });
  };
  filters.forEach(x => x.addEventListener('click', () => apply(x.dataset.f)));
  $$('[data-go]').forEach(c => c.addEventListener('click', () => apply(c.dataset.go)));
  $$('.tutor-card[data-href]').forEach(c => c.addEventListener('click', e => {
    if (!e.target.closest('a,button')) location.href = c.dataset.href;
  }));

  // ---------- Текущий пользователь и шапка ----------
  try { user = (await api('/api/me')).user; } catch (e) { user = null; }

  const actions = $('.header-actions');
  if (user && actions) {
    actions.replaceChildren();
    const chip = el('a', 'user-chip', user.name); chip.href = 'bookings.html'; chip.title = 'Мои записи';
    const out = el('button', 'btn btn-ghost btn-sm', 'Выйти'); out.type = 'button';
    out.addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); } catch (e) {} location.href = 'index.html'; });
    actions.append(chip, out);
    const nav = $('header nav');
    if (user.role === 'admin' && nav) { const a = el('a', null, 'Админ-панель'); a.href = 'admin.html'; nav.append(a); }
  }
  const hero = $('#createAccount');
  if (hero && user) { hero.textContent = 'Мои записи'; hero.href = 'bookings.html'; }

  // ---------- Вход ----------
  const loginForm = $('#loginForm');
  if (loginForm) {
    if (user) { location.replace(nextParam() || 'index.html'); return; }
    const next = nextParam();
    if (next) $('#otherAuth').href = 'register.html?next=' + next;
    const err = $('#formError');
    loginForm.addEventListener('submit', async e => {
      e.preventDefault(); err.textContent = '';
      const btn = $('[type=submit]', loginForm); btn.disabled = true;
      try {
        await api('/api/login', { method: 'POST', body: { email: loginForm.email.value, password: loginForm.password.value } });
        location.href = next || 'index.html';
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
  }

  // ---------- Регистрация ----------
  const reg = $('#registerForm');
  if (reg) {
    if (user) { location.replace(nextParam() || 'index.html'); return; }
    const next = nextParam();
    if (next) $('#otherAuth').href = 'login.html?next=' + next;
    const err = $('#formError');
    reg.addEventListener('submit', async e => {
      e.preventDefault(); err.className = 'form-error'; err.textContent = '';
      if (reg.password.value.length < 8) { err.textContent = 'Пароль должен быть не короче 8 символов.'; return; }
      if (reg.password.value !== reg.password2.value) { err.textContent = 'Пароли не совпадают. Введите их ещё раз.'; return; }
      const btn = $('[type=submit]', reg); btn.disabled = true;
      try {
        await api('/api/register', { method: 'POST', body: {
          name: reg.elements.name.value, phone: reg.phone.value, email: reg.email.value, password: reg.password.value, type: reg.type.value } });
        err.className = 'form-error form-ok';
        err.textContent = 'Аккаунт создан! Переходим дальше…';
        setTimeout(() => { location.href = next || 'index.html'; }, 800);
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
  }

  // ---------- Страница репетитора: расписание и запись на занятие ----------
  const tutorMain = $('main[data-tutor]');
  if (tutorMain) {
    const tutorId = tutorMain.dataset.tutor;
    const modal = $('#bookingModal'), form = $('#bookingForm'), gate = $('#authGate'), done = $('#bookingDone'), err = $('#bookingError');
    const daysEl = $('#days'), PER_PAGE = 7;
    let days = [], today = '', page = 0, selectedStart = null;

    const updateNearest = () => {
      const n = $('#nearest'); if (!n) return;
      for (const d of days) {
        const s = d.slots.find(x => x.state === 'free');
        if (s) { n.textContent = 'Ближайшее окошко: ' + d.weekday + ', ' + d.label + ', ' + s.time + ' (МСК)'; return; }
      }
      n.textContent = days.length ? 'Свободных окошек нет' : '';
    };

    const renderDays = () => {
      daysEl.replaceChildren();
      const pages = Math.max(1, Math.ceil(days.length / PER_PAGE));
      page = Math.min(page, pages - 1);
      const chunk = days.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
      chunk.forEach(day => {
        const col = el('div', 'day' + (day.date === today ? ' day-today' : ''));
        const h = el('h4', null, day.weekday);
        h.append(el('small', null, day.label + (day.date === today ? ' · сегодня' : '')));
        const ul = el('ul', 'slots-list');
        day.slots.forEach(s => {
          const li = el('li'), b = el('button', 'slot' + (s.start === selectedStart ? ' selected' : ''), s.time);
          b.type = 'button';
          b.dataset.start = s.start; b.dataset.date = day.weekday + ', ' + day.label; b.dataset.time = s.time;
          if (s.state !== 'free') { b.disabled = true; b.title = s.state === 'busy' ? 'Время занято' : 'Это время уже прошло'; }
          li.append(b); ul.append(li);
        });
        col.append(h, ul); daysEl.append(col);
      });
      if (chunk.length) {
        const f = chunk[0], l = chunk[chunk.length - 1];
        $('#weekLabel').textContent = f.label + ' — ' + l.label + ' · время МСК';
      }
      $('#weekPrev').hidden = $('#weekNext').hidden = pages <= 1; // при одной неделе кнопки не нужны
      $('#weekPrev').disabled = page === 0;
      $('#weekNext').disabled = page >= pages - 1;
      updateNearest();
    };

    const loadSchedule = async () => {
      try {
        const d = await api('/api/schedule?tutor=' + encodeURIComponent(tutorId));
        days = d.days; today = d.today; renderDays();
      } catch (e) { if (!days.length) daysEl.replaceChildren(el('p', 'section-sub', e.message)); }
    };
    await loadSchedule();
    // расписание обновляется само: прошедшее время гаснет, новые дни появляются
    setInterval(() => { if (!modal.classList.contains('open')) loadSchedule(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !modal.classList.contains('open')) loadSchedule(); });
    $('#weekPrev').addEventListener('click', () => { page = Math.max(0, page - 1); renderDays(); });
    $('#weekNext').addEventListener('click', () => { page += 1; renderDays(); });

    const close = () => { modal.classList.remove('open'); selectedStart = null; $$('.slot.selected').forEach(s => s.classList.remove('selected')); };
    const showGate = time => {
      const n = thisPage();
      $('#gateLogin').href = 'login.html?next=' + n;
      $('#gateRegister').href = 'register.html?next=' + n;
      $('#gateTime').textContent = time;
      form.hidden = true; done.hidden = true; gate.hidden = false;
    };

    daysEl.addEventListener('click', e => {
      const slot = e.target.closest('.slot');
      if (!slot || slot.disabled) return;
      $$('.slot.selected').forEach(s => s.classList.remove('selected'));
      slot.classList.add('selected');
      selectedStart = slot.dataset.start;
      const time = slot.dataset.date + ', ' + slot.dataset.time + ' (МСК)';
      $('#summaryTime').textContent = time;
      $('#selectedSlot').value = selectedStart;
      err.textContent = ''; done.hidden = true;
      if (!user) { showGate(time); modal.classList.add('open'); $('#gateLogin').focus(); return; }
      gate.hidden = true; form.hidden = false;
      if (!form.student.value) form.student.value = user.type === 'student' ? user.name : '';
      if (!form.phone.value) form.phone.value = user.phone || '';
      if (!form.email.value) form.email.value = user.email || '';
      modal.classList.add('open'); form.student.focus();
    });

    $('.close-modal', modal).addEventListener('click', close);
    $('.close-done', modal).addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

    form.addEventListener('submit', async e => {
      e.preventDefault(); err.textContent = '';
      const btn = $('[type=submit]', form); btn.disabled = true;
      try {
        const { booking } = await api('/api/bookings', { method: 'POST', body: {
          tutor: tutorId, start: $('#selectedSlot').value, student: form.student.value, phone: form.phone.value, email: form.email.value,
          grade: form.grade.value, subject: form.subject.value, goal: form.goal.value, comment: form.comment.value } });
        $('#doneText').textContent = 'Мы передали заявку: ' + $('#summaryTime').textContent + '. Репетитор свяжется с вами по телефону ' +
          booking.phone + '. Заявка сохранена в разделе «Мои записи».';
        form.hidden = true; done.hidden = false;
        form.grade.value = ''; form.subject.value = ''; form.goal.value = ''; form.comment.value = '';
        selectedStart = null; loadSchedule();
      } catch (ex) {
        if (ex.status === 401) { user = null; showGate($('#summaryTime').textContent); }
        else { err.textContent = ex.message; if (ex.status === 409 || ex.status === 400) loadSchedule(); }
      } finally { btn.disabled = false; }
    });
  }

  // ---------- Мои записи (с историей) ----------
  const list = $('#bookingsList');
  if (list) {
    const empty = (text, buttons) => {
      list.replaceChildren();
      const d = el('div', 'empty'); d.append(el('p', null, text));
      buttons.forEach(([label, href, cls]) => { const a = el('a', 'btn ' + cls, label); a.href = href; d.append(a, document.createTextNode(' ')); });
      list.append(d);
    };
    const render = async () => {
      let items;
      try { items = (await api('/api/bookings')).bookings; }
      catch (ex) { empty(ex.message, []); return; }
      if (!items.length) { empty('У вас пока нет записей на занятия.', [['Выбрать репетитора', 'index.html#tutors', 'btn-primary']]); return; }
      list.replaceChildren();
      items.forEach(b => {
        const d = el('div', 'booking-item'), t = el('div');
        t.append(el('b', null, b.tutorName),
          el('span', 'meta', b.slot + ' МСК · ' + b.subject + ' · ' + b.goal),
          el('span', 'meta', b.grade + ' класс · ' + b.student + ' · создана ' + fmtDate(b.createdAt)),
          el('span', 'status st-' + b.status, STATUS[b.status]));
        d.append(t);
        if (b.status === 'new' || b.status === 'confirmed') {
          const btn = el('button', 'btn btn-ghost btn-sm', 'Отменить запись'); btn.type = 'button';
          btn.addEventListener('click', async () => {
            if (!confirm('Отменить запись на ' + b.slot + '?')) return;
            btn.disabled = true;
            try { await api('/api/bookings/' + b.id + '/cancel', { method: 'POST' }); } catch (ex) { alert(ex.message); }
            render();
          });
          d.append(btn);
        }
        list.append(d);
      });
    };
    if (!user) empty('Чтобы увидеть свои записи, войдите в аккаунт.', [['Войти', 'login.html?next=bookings.html', 'btn-primary'], ['Регистрация', 'register.html?next=bookings.html', 'btn-ghost']]);
    else render();
  }

  // ---------- Админ-панель ----------
  const adminApp = $('#adminApp');
  if (adminApp) {
    if (!user || user.role !== 'admin') { $('#adminGate').hidden = false; return; }
    adminApp.hidden = false;
    let bookings = [], users = [], today = '', nowStr = '';
    let cfg = { workStart: 14, workEnd: 21, tutors: TUTOR_NAMES };
    let weekOffset = 0, calTutor = '', showCancelled = false, openId = null;
    const fStatus = $('#fStatus'), fTutor = $('#fTutor'), fSearch = $('#fSearch');
    fStatus.append(new Option('Все статусы', ''));
    Object.entries(STATUS).forEach(([k, v]) => fStatus.append(new Option(v, k)));
    const modalStatus = $('#adminModalStatus');
    Object.entries(STATUS).forEach(([k, v]) => modalStatus.append(new Option(v, k)));

    const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const p2 = n => String(n).padStart(2, '0');
    const dayMs = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
    const ymdOf = ms => { const d = new Date(ms); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()); };
    const shortDate = ms => { const d = new Date(ms); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; };
    const weekStartMs = () => { const t = dayMs(today); return t - ((new Date(t).getUTCDay() + 6) % 7) * 86400e3 + weekOffset * 7 * 86400e3; };
    const hourOf = s => Number(s.slice(11, 13));
    const isActive = b => b.status !== 'cancelled';
    const pluralH = n => n + ' ч';
    const initials = name => name.split(' ').map(w => w[0]).join('');
    const td = (tr, text, sub) => { const c = el('td', null, text); if (sub) c.append(el('span', 'sub', sub)); tr.append(c); return c; };

    // --- Календарь ---
    const renderCalendar = () => {
      const ws = weekStartMs();
      const dates = [...Array(7)].map((_, i) => ymdOf(ws + i * 86400e3));
      const tutorKeys = calTutor ? [calTutor] : Object.keys(cfg.tutors);
      const inWeek = bookings.filter(b => b.start && dates.includes(b.start.slice(0, 10)) && tutorKeys.includes(b.tutor));
      const visible = inWeek.filter(b => showCancelled || isActive(b));
      $('#calRange').textContent = shortDate(ws) + ' — ' + shortDate(ws + 6 * 86400e3) + ' ' + new Date(ws + 6 * 86400e3).getUTCFullYear();

      // Карточки нагрузки: часы и ученики каждого репетитора за неделю
      const load = $('#calLoad'); load.replaceChildren();
      const capacity = (cfg.workEnd - cfg.workStart) * 7;
      tutorKeys.forEach(k => {
        const mine = inWeek.filter(b => b.tutor === k && isActive(b));
        const todayN = bookings.filter(b => b.tutor === k && isActive(b) && b.start && b.start.slice(0, 10) === today).length;
        const pending = mine.filter(b => b.status === 'new').length;
        const hours = mine.length, pct = Math.round(hours / capacity * 100);
        const byStudent = {};
        mine.forEach(b => { byStudent[b.student] = (byStudent[b.student] || 0) + 1; });
        const card = el('div', 'load-card tutor-' + k);
        const head = el('div', 'load-head'); head.append(el('h4', null, cfg.tutors[k] || k), el('span', 'load-hours', pluralH(hours)));
        const bar = el('div', 'load-bar'), fill = el('i'); fill.style.width = Math.min(100, pct) + '%'; bar.append(fill);
        const meta = el('p', 'load-meta', 'Занято ' + hours + ' из ' + capacity + ' окошек (' + pct + '%) · сегодня: ' + pluralH(todayN) + (pending ? ' · ждут подтверждения: ' + pending : ''));
        const who = el('p', 'load-who');
        const names = Object.entries(byStudent).sort((a, b) => b[1] - a[1]);
        who.textContent = names.length ? 'Ученики недели: ' + names.map(([n, c]) => n + (c > 1 ? ' ×' + c : '')).join(', ') : 'На этой неделе записей нет';
        card.append(head, bar, meta, who); load.append(card);
      });

      // Сетка: строки — часы, столбцы — дни недели
      let hMin = cfg.workStart, hMax = cfg.workEnd - 1;
      visible.forEach(b => { hMin = Math.min(hMin, hourOf(b.start)); hMax = Math.max(hMax, hourOf(b.start)); });
      const grid = $('#calGrid'); grid.replaceChildren();
      grid.append(el('div', 'cal-corner', 'МСК'));
      dates.forEach((dt, i) => {
        const n = visible.filter(b => b.start.startsWith(dt) && isActive(b)).length;
        const head = el('div', 'cal-head' + (dt === today ? ' is-today' : ''));
        head.append(el('b', null, DOW[i] + ', ' + shortDate(dayMs(dt))), el('span', null, n ? pluralH(n) : (dt === today ? 'сегодня' : '')));
        grid.append(head);
      });
      for (let h = hMin; h <= hMax; h++) {
        grid.append(el('div', 'cal-time', p2(h) + ':00'));
        dates.forEach(dt => {
          const start = dt + ' ' + p2(h) + ':00';
          const hourPast = start.slice(0, 13) < nowStr.slice(0, 13);
          const cell = el('div', 'cal-cell' + (hourPast ? ' is-past' : '') + (start.slice(0, 13) === nowStr.slice(0, 13) ? ' is-now' : '') + (dt === today ? ' col-today' : ''));
          visible.filter(b => b.start === start).forEach(b => {
            const overdue = hourPast && (b.status === 'new' || b.status === 'confirmed');
            const chip = el('button', 'chip-b st-' + b.status + (overdue ? ' overdue' : '') + ' tutor-' + b.tutor);
            chip.type = 'button';
            chip.title = b.student + ', ' + b.subject + ', ' + b.goal + ' — ' + STATUS[b.status] + (overdue ? ' (время прошло, отметьте итог)' : '');
            const top = el('span', 'chip-top');
            if (!calTutor) top.append(el('em', 'tag tag-' + b.tutor, initials(b.tutorName)));
            top.append(el('b', null, b.student));
            chip.append(top, el('span', 'chip-sub', b.grade + ' кл · ' + ({ 'Математика': 'Мат.', 'Информатика': 'Инф.' }[b.subject] || b.subject) + ' · ' + b.goal));
            chip.addEventListener('click', () => openBooking(b.id));
            cell.append(chip);
          });
          grid.append(cell);
        });
      }
    };

    // --- Карточка записи ---
    const adminModal = $('#adminModal'), modalErr = $('#adminModalError');
    const closeModal = () => { adminModal.classList.remove('open'); openId = null; };
    const fillModal = () => {
      const b = bookings.find(x => x.id === openId); if (!b) { closeModal(); return; }
      $('#adminModalTitle').textContent = b.student;
      $('#adminModalWhen').textContent = b.tutorName + ' · ' + b.slot + ' (МСК)';
      const dl = $('#adminModalBody'); dl.replaceChildren();
      const row = (k, v, href) => {
        dl.append(el('dt', null, k));
        const dd = el('dd');
        if (href && v) { const a = el('a', null, v); a.href = href; dd.append(a); } else dd.textContent = v || '—';
        dl.append(dd);
      };
      row('Телефон', b.phone, 'tel:' + b.phone.replace(/[^\d+]/g, ''));
      row('Email', b.email, 'mailto:' + b.email);
      row('Класс', b.grade + ' класс');
      row('Предмет', b.subject);
      row('Цель', b.goal);
      row('Комментарий', b.comment);
      row('Аккаунт', b.account.name + (b.account.email ? ' (' + b.account.email + ')' : ''));
      row('Создана', fmtDate(b.createdAt));
      modalStatus.value = b.status;
    };
    const openBooking = id => { openId = id; modalErr.textContent = ''; fillModal(); adminModal.classList.add('open'); modalStatus.focus(); };
    modalStatus.addEventListener('change', async () => {
      modalErr.textContent = ''; modalStatus.disabled = true;
      try { await api('/api/admin/bookings/' + openId + '/status', { method: 'POST', body: { status: modalStatus.value } }); }
      catch (ex) { modalErr.textContent = ex.message; }
      modalStatus.disabled = false; await load();
    });
    $('.close-modal', adminModal).addEventListener('click', closeModal);
    adminModal.addEventListener('click', e => { if (e.target === adminModal) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

    // --- Таблица записей и пользователи ---
    const render = () => {
      const stats = $('#adminStats'); stats.replaceChildren();
      const todayN = bookings.filter(b => isActive(b) && b.start && b.start.slice(0, 10) === today).length;
      [[todayN, 'занятий сегодня'], [bookings.filter(b => b.status === 'new').length, 'ожидают подтверждения'],
       [bookings.filter(b => b.status === 'confirmed').length, 'подтверждено'], [bookings.length, 'всего записей'], [users.length, 'пользователей']].forEach(([n, l]) => {
        const d = el('div', 'big-stat'); d.append(el('b', null, String(n)), el('span', null, l)); stats.append(d);
      });

      renderCalendar();

      const q = fSearch.value.trim().toLowerCase();
      const rows = bookings.filter(b =>
        (!fStatus.value || b.status === fStatus.value) && (!fTutor.value || b.tutor === fTutor.value) &&
        (!q || [b.student, b.phone, b.email, b.slot, b.account.name, b.account.email].join(' ').toLowerCase().includes(q)));
      const body = $('#bookingsBody'); body.replaceChildren();
      $('#bookingsEmpty').hidden = rows.length > 0;
      rows.forEach(b => {
        const tr = el('tr', b.status === 'new' ? 'row-new' : '');
        td(tr, String(b.id)); td(tr, fmtDate(b.createdAt)); td(tr, b.tutorName); td(tr, b.slot);
        td(tr, b.student); td(tr, b.phone, b.email || '');
        td(tr, b.grade + ' класс', b.subject + ' · ' + b.goal); td(tr, b.comment || '—');
        td(tr, b.account.name, b.account.email);
        const c = el('td'), sel = el('select'); sel.setAttribute('aria-label', 'Статус записи ' + b.id);
        Object.entries(STATUS).forEach(([k, v]) => sel.append(new Option(v, k)));
        sel.value = b.status;
        sel.addEventListener('change', async () => {
          sel.disabled = true;
          try { await api('/api/admin/bookings/' + b.id + '/status', { method: 'POST', body: { status: sel.value } }); }
          catch (ex) { alert(ex.message); }
          load();
        });
        c.append(sel); tr.append(c); body.append(tr);
      });

      const ub = $('#usersBody'); ub.replaceChildren();
      users.forEach(u => {
        const tr = el('tr');
        td(tr, String(u.id)); td(tr, fmtDate(u.createdAt)); td(tr, u.name); td(tr, u.email); td(tr, u.phone);
        td(tr, u.role === 'admin' ? 'Администратор' : (u.type === 'student' ? 'Ученик' : 'Родитель')); td(tr, String(u.bookingsCount));
        ub.append(tr);
      });
      if (openId != null && adminModal.classList.contains('open') && !modalStatus.disabled) fillModal();
    };

    const load = async () => {
      try {
        const [b, u] = await Promise.all([api('/api/admin/bookings'), api('/api/admin/users')]);
        bookings = b.bookings; users = u.users; today = b.today; nowStr = b.now; cfg = b.config; render();
      } catch (ex) { if (ex.status === 401 || ex.status === 403) location.reload(); }
    };
    [fStatus, fTutor].forEach(x => x.addEventListener('change', render));
    fSearch.addEventListener('input', render);
    $('#calPrev').addEventListener('click', () => { weekOffset--; renderCalendar(); });
    $('#calNext').addEventListener('click', () => { weekOffset++; renderCalendar(); });
    $('#calToday').addEventListener('click', () => { weekOffset = 0; renderCalendar(); });
    $('#calCancelled').addEventListener('change', e => { showCancelled = e.target.checked; renderCalendar(); });
    $$('[data-tutor]', $('#calTutors')).forEach(t => t.addEventListener('click', () => {
      calTutor = t.dataset.tutor;
      $$('[data-tutor]', $('#calTutors')).forEach(x => x.classList.toggle('active', x === t));
      renderCalendar();
    }));
    $$('[data-tab]').forEach(t => t.addEventListener('click', () => {
      $$('[data-tab]').forEach(x => x.classList.toggle('active', x === t));
      $('#tabCalendar').hidden = t.dataset.tab !== 'calendar';
      $('#tabBookings').hidden = t.dataset.tab !== 'bookings';
      $('#tabUsers').hidden = t.dataset.tab !== 'users';
    }));
    load();
    setInterval(load, 30000);
  }
});
