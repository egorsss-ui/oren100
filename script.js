document.addEventListener('DOMContentLoaded', async () => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const STATUS = { new: 'Ожидает подтверждения', confirmed: 'Подтверждена', done: 'Проведено', cancelled: 'Отменена' };
  const TUTOR_NAMES = { egor: 'Егор Артемович', valentina: 'Валентина Александровна' };
  let user = null;

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

  // ---------- Страница репетитора: запись на занятие ----------
  const tutorMain = $('main[data-tutor]');
  if (tutorMain) {
    const tutorId = tutorMain.dataset.tutor;
    const modal = $('#bookingModal'), form = $('#bookingForm'), gate = $('#authGate'), done = $('#bookingDone'), err = $('#bookingError');
    const slots = $$('.slot');
    const keyOf = s => s.dataset.date + ' ' + s.dataset.time;

    const updateNearest = () => {
      const first = slots.find(s => !s.disabled), n = $('#nearest');
      if (n) n.textContent = first ? 'Ближайшее окошко: ' + first.dataset.date + ', ' + first.dataset.time : 'Свободных окошек нет';
    };
    updateNearest();
    try {
      const { taken } = await api('/api/slots?tutor=' + encodeURIComponent(tutorId));
      slots.forEach(s => { if (taken.includes(keyOf(s))) s.disabled = true; });
      updateNearest();
    } catch (e) {}

    const close = () => { modal.classList.remove('open'); slots.forEach(s => s.classList.remove('selected')); };
    const showGate = time => {
      const n = thisPage();
      $('#gateLogin').href = 'login.html?next=' + n;
      $('#gateRegister').href = 'register.html?next=' + n;
      $('#gateTime').textContent = time;
      form.hidden = true; done.hidden = true; gate.hidden = false;
    };

    slots.forEach(slot => slot.addEventListener('click', () => {
      slots.forEach(s => s.classList.remove('selected'));
      slot.classList.add('selected');
      const time = slot.dataset.date + ', ' + slot.dataset.time;
      $('#summaryTime').textContent = time;
      $('#selectedSlot').value = keyOf(slot);
      err.textContent = ''; done.hidden = true;
      if (!user) { showGate(time); modal.classList.add('open'); $('#gateLogin').focus(); return; }
      gate.hidden = true; form.hidden = false;
      if (!form.student.value) form.student.value = user.type === 'student' ? user.name : '';
      if (!form.phone.value) form.phone.value = user.phone || '';
      if (!form.email.value) form.email.value = user.email || '';
      modal.classList.add('open'); form.student.focus();
    }));

    $('.close-modal', modal).addEventListener('click', close);
    $('.close-done', modal).addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

    form.addEventListener('submit', async e => {
      e.preventDefault(); err.textContent = '';
      const btn = $('[type=submit]', form); btn.disabled = true;
      const slotValue = $('#selectedSlot').value;
      const mark = () => { const s = slots.find(x => keyOf(x) === slotValue); if (s) { s.disabled = true; s.classList.remove('selected'); } updateNearest(); };
      try {
        const { booking } = await api('/api/bookings', { method: 'POST', body: {
          tutor: tutorId, slot: slotValue, student: form.student.value, phone: form.phone.value, email: form.email.value,
          grade: form.grade.value, subject: form.subject.value, goal: form.goal.value, comment: form.comment.value } });
        $('#doneText').textContent = 'Мы передали заявку: ' + $('#summaryTime').textContent + '. Репетитор свяжется с вами по телефону ' +
          booking.phone + '. Заявка сохранена в разделе «Мои записи».';
        form.hidden = true; done.hidden = false;
        form.grade.value = ''; form.subject.value = ''; form.goal.value = ''; form.comment.value = '';
        mark();
      } catch (ex) {
        if (ex.status === 401) { user = null; showGate($('#summaryTime').textContent); }
        else { err.textContent = ex.message; if (ex.status === 409) mark(); }
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
          el('span', 'meta', b.slot + ' · ' + b.subject + ' · ' + b.goal),
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
    let bookings = [], users = [];
    const fStatus = $('#fStatus'), fTutor = $('#fTutor'), fSearch = $('#fSearch');
    fStatus.append(new Option('Все статусы', ''));
    Object.entries(STATUS).forEach(([k, v]) => fStatus.append(new Option(v, k)));

    const td = (tr, text, sub) => { const c = el('td', null, text); if (sub) c.append(el('span', 'sub', sub)); tr.append(c); return c; };

    const render = () => {
      const stats = $('#adminStats'); stats.replaceChildren();
      [[bookings.length, 'всего записей'], [bookings.filter(b => b.status === 'new').length, 'ожидают подтверждения'],
       [bookings.filter(b => b.status === 'confirmed').length, 'подтверждено'], [users.length, 'пользователей']].forEach(([n, l]) => {
        const d = el('div', 'big-stat'); d.append(el('b', null, String(n)), el('span', null, l)); stats.append(d);
      });

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
    };

    const load = async () => {
      try {
        const [b, u] = await Promise.all([api('/api/admin/bookings'), api('/api/admin/users')]);
        bookings = b.bookings; users = u.users; render();
      } catch (ex) { if (ex.status === 401 || ex.status === 403) location.reload(); }
    };
    [fStatus, fTutor].forEach(x => x.addEventListener('change', render));
    fSearch.addEventListener('input', render);
    $$('[data-tab]').forEach(t => t.addEventListener('click', () => {
      $$('[data-tab]').forEach(x => x.classList.toggle('active', x === t));
      $('#tabBookings').hidden = t.dataset.tab !== 'bookings';
      $('#tabUsers').hidden = t.dataset.tab !== 'users';
    }));
    load();
    setInterval(load, 30000);
  }
});
