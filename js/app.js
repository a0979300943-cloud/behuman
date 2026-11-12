/* ============================================================
 * behuman · 成为人类吧！
 * 剧情化专注自习网站主逻辑
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 工具 ---------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

  /* ---------------- 账号会话（纯本地账号，见下方 account 模块） ----------------
   * accountName 为空 = 游客（沿用 bh.xxx 键）；
   * 登录后数据键自动变为 bh.u.<代号>.xxx，不同账号数据完全隔离。
   * 账号表 bh.accounts / 会话 bh.session 为全局键，不随前缀变化。 */
  const SESSION_KEY = 'bh.session';
  const ACCOUNTS_KEY = 'bh.accounts';
  let accountName = (function () {
    try { return localStorage.getItem(SESSION_KEY) || ''; } catch (e) { return ''; }
  })();
  const keyFor = (k) => (!accountName ? k : k.replace(/^bh\./, 'bh.u.' + accountName + '.'));

  const store = {
    get(k, d) {
      try {
        const raw = localStorage.getItem(keyFor(k));
        return raw == null ? d : JSON.parse(raw);
      } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(keyFor(k), JSON.stringify(v)); } catch (e) {}
    },
    remove(k) { try { localStorage.removeItem(keyFor(k)); } catch (e) {} }
  };

  const KEY = {
    state: 'bh.state',
    settings: 'bh.settings',
    intro: 'bh.intro',
    feedback: 'bh.feedback',
    notes: 'bh.notes',
    profile: 'bh.profile',
    live: 'bh.live'
  };

  /* 默认设置：清空数据、导入、首次启动都复用这一份，避免字段缺失 */
  const SETTINGS_DEFAULT = {
    defaultMin: 25,
    sound: true,
    strictMode: false,
    defaultWhiteNoise: true,
    rainVolume: 50,
    biliBgmOn: true,
    biliBgmMode: 'seq',
    biliBgmVolume: 100
  };

  /* ---------------- 媒体文件存储（IndexedDB，存 Blob，容量大） ----------------
   * 键名随账号隔离：游客 audio / 账号 <代号>:audio */
  const mkey = (k) => (accountName ? accountName + ':' + k : k);
  const media = {
    DB_NAME: 'bh-media',
    STORE: 'files',
    _dbp: null,
    db() {
      if (this._dbp) return this._dbp;
      this._dbp = new Promise((resolve, reject) => {
        try {
          const r = indexedDB.open(this.DB_NAME, 1);
          r.onupgradeneeded = () => {
            if (!r.result.objectStoreNames.contains(this.STORE)) r.result.createObjectStore(this.STORE);
          };
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        } catch (e) { reject(e); }
      });
      return this._dbp;
    },
    async tx(mode, fn) {
      const d = await this.db();
      return new Promise((resolve, reject) => {
        const t = d.transaction(this.STORE, mode);
        const req = fn(t.objectStore(this.STORE));
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    },
    put(key, file) {
      return this.tx('readwrite', s => s.put({
        blob: file, name: file.name, type: file.type,
        size: file.size, addedAt: new Date().toISOString()
      }, mkey(key)));
    },
    get(key) { return this.tx('readonly', s => s.get(mkey(key))).then(r => r || null).catch(() => null); },
    del(key) { return this.tx('readwrite', s => s.delete(mkey(key))).catch(() => {}); },
    /* 只清当前身份（游客键不含冒号；账号键为 "<代号>:" 前缀），不动其他账号 */
    async clear() {
      try {
        const d = await this.db();
        await new Promise((resolve) => {
          const t = d.transaction(this.STORE, 'readwrite');
          const s = t.objectStore(this.STORE);
          const req = s.getAllKeys();
          req.onsuccess = () => {
            (req.result || []).forEach(k => {
              const ks = String(k);
              const mine = accountName ? ks.startsWith(accountName + ':') : (ks.indexOf(':') === -1);
              if (mine) s.delete(k);
            });
          };
          t.oncomplete = () => resolve();
          t.onerror = () => resolve();
          t.onabort = () => resolve();
        });
      } catch (e) {}
    }
  };
  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ---------------- B站视频链接解析 ---------------- */
  function parseBiliId(raw) {
    const s = String(raw || '').trim();
    let m = s.match(/BV[0-9A-Za-z]{10}/);
    if (m) return { t: 'bv', id: m[0] };
    m = s.match(/[aA][vV](\d{2,15})/);
    if (m) return { t: 'aid', id: m[1] };
    return null;
  }

  const freshState = () => ({
    totalMinutes: 0,
    sessions: 0,
    success: 0,
    failed: 0,
    interruptions: 0,
    longestMinutes: 0,
    days: [],
    daily: {},
    history: []
  });

  let state = Object.assign(freshState(), store.get(KEY.state, {}));
  if (!state.daily || typeof state.daily !== 'object') state.daily = {};
  if (!Array.isArray(state.history)) state.history = [];
  let settings = Object.assign({}, SETTINGS_DEFAULT, store.get(KEY.settings, {}));

  const saveState = () => store.set(KEY.state, state);
  const saveSettings = () => store.set(KEY.settings, settings);

  /* ---------------- 账号模块（纯本地，无后端） ----------------
   * 账号表：bh.accounts = { 代号: { salt, hash, createdAt } }
   * 密码以 SHA-256(salt + 密码) 存储，不存明文；仅防本机直接窥视，非服务器级安全 */
  function loadAccounts() {
    try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveAccounts(a) {
    try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(a)); } catch (e) {}
  }
  function randomSalt() {
    const arr = new Uint8Array(12);
    window.crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  }
  async function hashPwd(salt, pwd) {
    const data = new TextEncoder().encode('bh::' + salt + '::' + pwd);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /* 注册时把游客的文本数据复制到新账号空间（无缝继承本机旧记录）
   * 注意：读取用 keyFor('bh.state') → 'bh.u.<user>.state'，写入必须同一形式 */
  function copyGuestDataToAccount(user) {
    Object.keys(KEY).forEach(k => {
      try {
        const raw = localStorage.getItem(KEY[k]);
        if (raw != null) localStorage.setItem(k.replace(/^bh\./, 'bh.u.' + user + '.'), raw);
      } catch (e) {}
    });
  }

  /* 切换身份后重新载入内存数据并刷新界面 */
  function afterAccountChanged() {
    state = Object.assign(freshState(), store.get(KEY.state, {}));
    if (!state.daily || typeof state.daily !== 'object') state.daily = {};
    if (!Array.isArray(state.history)) state.history = [];
    settings = Object.assign({}, SETTINGS_DEFAULT, store.get(KEY.settings, {}));
    renderStats();
    if (typeof syncSettingsUI === 'function') syncSettingsUI();
    if (typeof bookOnAccountChanged === 'function') bookOnAccountChanged();
    renderAccountUI();
  }
  function renderAccountUI() {
    $('#account-label').textContent = accountName || '游客';
    renderAvatar();
    const profileModal = $('#modal-profile');
    if (profileModal && !profileModal.hidden) renderProfile();
  }

  async function accountRegister(name, pwd) {
    const accounts = loadAccounts();
    if (accounts[name]) return { ok: false, msg: '该身份代号已被注册，换一个吧' };
    const guestAudio = accountName ? null : await media.get('audio');
    const salt = randomSalt();
    const hash = await hashPwd(salt, pwd);
    copyGuestDataToAccount(name);
    accounts[name] = { salt: salt, hash: hash, createdAt: new Date().toISOString() };
    saveAccounts(accounts);
    try { localStorage.setItem(SESSION_KEY, name); } catch (e) {}
    accountName = name;
    if (guestAudio && guestAudio.blob) await media.put('audio', guestAudio.blob);
    afterAccountChanged();
    return { ok: true };
  }

  async function accountLogin(name, pwd) {
    const accounts = loadAccounts();
    const rec = accounts[name];
    if (!rec) return { ok: false, msg: '没有找到这个身份代号' };
    const hash = await hashPwd(rec.salt, pwd);
    if (hash !== rec.hash) return { ok: false, msg: '密码不正确，请重试' };
    try { localStorage.setItem(SESSION_KEY, name); } catch (e) {}
    accountName = name;
    afterAccountChanged();
    return { ok: true };
  }

  function accountLogout() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    accountName = '';
    afterAccountChanged();
  }

  function fmtTime(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return m + ':' + s;
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ---------------- 音效（WebAudio 合成，无需素材） ---------------- */
  let audioCtx = null;
  function ac() {
    if (!settings.sound) return null;
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  function tone(freq, dur, type, vol, when) {
    const ctx = ac();
    if (!ctx) return;
    const t = ctx.currentTime + (when || 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.08, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
  const sfx = {
    whoosh() { tone(220, 0.5, 'sine', 0.05); tone(330, 0.5, 'sine', 0.035, 0.08); },
    select() { tone(520, 0.08, 'triangle', 0.05); },
    alarm() { [0, 0.35, 0.7].forEach(d => tone(880, 0.16, 'square', 0.045, d)); },
    success() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.35, 'triangle', 0.06, i * 0.16)); },
    fail() { [392, 311, 262].forEach((f, i) => tone(f, 0.4, 'sawtooth', 0.045, i * 0.22)); },
    /* 军号（小号）音效：sawtooth 模拟铜管谐波，上行号角动机 + 长音收尾。
       off = 相对当前时刻的起始偏移（秒），用于在 success 琶音之后衔接 */
    bugle(off) {
      const o = off || 0;
      [392, 523, 659, 784].forEach((f, i) => tone(f, 0.42, 'sawtooth', 0.05, o + i * 0.16));
      tone(659, 0.9, 'sawtooth', 0.055, o + 0.66);
    }
  };

  /* ---------------- 星空 ---------------- */
  function buildStars() {
    const box = $('#stars');
    let html = '';
    const layers = [
      { n: 90, size: 1, max: 12, dur: 4 },
      { n: 50, size: 2, max: 20, dur: 6 },
      { n: 24, size: 3, max: 30, dur: 9 }
    ];
    layers.forEach((L, li) => {
      for (let i = 0; i < L.n; i++) {
        const x = Math.random() * 100;
        const y = Math.random() * 100;
        const op = 0.3 + Math.random() * 0.7;
        const delay = (Math.random() * L.dur).toFixed(2);
        const dur = (L.dur * (0.7 + Math.random() * 0.6)).toFixed(2);
        html += '<i class="star l' + li + '" style="left:' + x.toFixed(2) + '%;top:' + y.toFixed(2) +
          '%;width:' + L.size + 'px;height:' + L.size + 'px;opacity:' + op.toFixed(2) +
          ';animation-delay:' + delay + 's;animation-duration:' + dur + 's"></i>';
      }
    });
    box.innerHTML = html;
  }

  /* ---------------- Toast ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  /* ---------------- 弹窗通用（含焦点管理） ---------------- */
  let lastFocusedEl = null;
  function focusables(root) {
    return $$('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', root)
      .filter(el => el.offsetParent !== null || el === document.activeElement);
  }
  function openModal(id) {
    const m = $('#' + id);
    lastFocusedEl = document.activeElement;
    m.hidden = false;
    requestAnimationFrame(() => m.classList.add('show'));
    // 兜底：页面在后台标签等情况下 rAF 可能不触发，确保弹窗最终显示
    setTimeout(() => m.classList.add('show'), 60);
    setTimeout(() => {
      const list = focusables(m);
      const target = m.querySelector('[data-autofocus]') || list[0] || m.querySelector('.modal');
      if (target) {
        if (!target.hasAttribute('tabindex') && target.classList.contains('modal')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    }, 90);
    sfx.select();
  }
  function closeModal(m) {
    if (typeof m === 'string') m = $('#' + m);
    if (!m || m.hidden) return;
    m.classList.remove('show');
    setTimeout(() => { m.hidden = true; }, 250);
    if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') {
      try { lastFocusedEl.focus({ preventScroll: true }); } catch (e) {}
    }
    lastFocusedEl = null;
  }
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) { closeModal(closeBtn.closest('.modal-mask')); return; }
    const mask = e.target.closest('.modal-mask');
    if (mask && e.target === mask) closeModal(mask);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal-mask.show').forEach(closeModal);
    if (e.key !== 'Tab') return;
    const shown = $$('.modal-mask.show');
    const m = shown[shown.length - 1];
    if (!m) return;
    const list = focusables(m);
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !m.contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !m.contains(document.activeElement))) {
      e.preventDefault(); first.focus();
    }
  });

  /* ---------------- 开场剧情播放器 ---------------- */
  const intro = {
    el: $('#intro'),
    img: $('#intro-img'),
    text: $('#intro-text'),
    bar: $('#intro-bar'),
    skip: $('#intro-skip'),
    waves: $('#intro-waves'),
    wavesRAF: null,
    timers: [],
    started: false,
    total: 0,
    startTime: 0,
    progressTimer: null,

    lineMs(text) { return Math.min(4200, 1500 + text.length * 120); },

    preload() {
      const loads = window.STORY.map(s => new Promise(resolve => {
        const im = new Image();
        im.onload = () => { s.bad = false; s._src = s.img; resolve(); };
        im.onerror = () => { s.bad = true; s._src = null; resolve(); };
        im.src = s.img;
      }));
      return Promise.all(loads);
    },

    async play() {
      if (this.started) return;
      this.started = true;
      this.el.hidden = false;
      this.el.classList.add('is-loading');
      this.text.textContent = '正在接收来自深空的信号…';
      this.playStory();
    },

    async playStory() {
      await Promise.race([
        this.preload(),
        new Promise(r => setTimeout(r, 9000))
      ]);
      if (!this.started) return;
      this.el.classList.remove('is-loading');

      // 总时长（含每场 0.54s 转场）
      this.total = window.STORY.reduce((sum, s) =>
        sum + s.lines.reduce((a, l) => a + this.lineMs(l), 0) + 540, 0);

      this.startTime = performance.now();
      this.progressTimer = setInterval(() => {
        const p = Math.min(1, (performance.now() - this.startTime) / this.total);
        this.bar.style.width = (p * 100).toFixed(2) + '%';
      }, 100);

      sfx.whoosh();
      this.runScene(0, 0);
    },

    runScene(si, accDelay) {
      if (si >= window.STORY.length) { this.finish(); return; }
      const scene = window.STORY[si];

      const media = $('.intro__media');
      const show = () => {
        this.img.style.opacity = '0';
        setTimeout(() => {
          media.dataset.scene = String(si + 1);
          this.el.classList.toggle('media-fallback', !!scene.bad);
          this.img.classList.remove('kenburns-a', 'kenburns-b');
          void this.img.offsetWidth;
          if (scene.bad) {
            this.img.removeAttribute('src');
          } else {
            this.img.src = scene._src || scene.img;
            this.img.classList.add(si % 2 === 0 ? 'kenburns-a' : 'kenburns-b');
          }
          this.img.style.opacity = '1';
          sfx.whoosh();
        }, 260);
        this.runLine(si, 0);
      };
      this.timers.push(setTimeout(show, accDelay));
    },

    runLine(si, li) {
      const scene = window.STORY[si];
      if (li >= scene.lines.length) {
        // 下一场
        this.timers.push(setTimeout(() => this.runScene(si + 1, 0), this.lineMs(scene.lines[scene.lines.length - 1]) + 280));
        return;
      }
      const line = scene.lines[li];
      this.text.classList.remove('caption-in');
      void this.text.offsetWidth;
      this.text.textContent = line;
      this.text.classList.add('caption-in');
      this.syncWaves(line);
      this.timers.push(setTimeout(() => this.runLine(si, li + 1), this.lineMs(line)));
    },

    /* ---- 「快乐」信号波形画面：台词匹配时显示，否则隐藏 ---- */
    syncWaves(line) {
      if (line && line.indexOf('快乐') !== -1) this.showWaves();
      else this.hideWaves();
    },

    showWaves() {
      if (this.wavesRAF) return;
      const cv = this.waves;
      cv.hidden = false;
      requestAnimationFrame(() => cv.classList.add('show'));
      const ctx = cv.getContext('2d');
      const W = cv.width, H = cv.height, mid = H / 2;
      // 背景杂波：频率、振幅各异
      const bg = [
        { f: 2.2, a: 44, sp: 1.6, ph: 0.0, c: 'rgba(124,232,255,0.30)', w: 1.6 },
        { f: 3.6, a: 66, sp: -1.2, ph: 1.4, c: 'rgba(110,150,255,0.24)', w: 1.4 },
        { f: 5.4, a: 28, sp: 2.1, ph: 2.6, c: 'rgba(160,120,255,0.22)', w: 1.3 },
        { f: 7.8, a: 50, sp: -1.8, ph: 3.8, c: 'rgba(90,200,220,0.20)', w: 1.2 },
        { f: 9.6, a: 22, sp: 2.6, ph: 5.1, c: 'rgba(124,232,255,0.15)', w: 1.1 }
      ];
      const env = x => Math.sin(Math.PI * x / W); // 两端收束，中间最大
      const t0 = performance.now();
      const self = this;
      const draw = (now) => {
        const t = (now - t0) / 1000;
        ctx.clearRect(0, 0, W, H);

        // 仪器网格
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(124,232,255,0.07)';
        for (let x = 80; x < W; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
        for (let y = 62; y < H; y += 62) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
        // 中轴
        ctx.strokeStyle = 'rgba(124,232,255,0.16)';
        ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();

        const plot = (f, a, sp, ph) => {
          ctx.beginPath();
          for (let x = 0; x <= W; x += 4) {
            const y = mid + Math.sin(x / W * Math.PI * 2 * f + t * sp + ph) * a * env(x);
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        };

        bg.forEach(wv => {
          ctx.strokeStyle = wv.c;
          ctx.lineWidth = wv.w;
          plot(wv.f, wv.a, wv.sp, wv.ph);
        });

        // 橙色主波：频率最高、振幅最大
        ctx.save();
        ctx.shadowColor = 'rgba(255,158,64,0.85)';
        ctx.shadowBlur = 24;
        ctx.strokeStyle = '#ffb35c';
        ctx.lineWidth = 4.2;
        plot(13.5, 106, 3.0, 0);
        ctx.restore();

        // 仪器标注
        ctx.font = '24px "Courier New", monospace';
        ctx.fillStyle = 'rgba(147,166,200,0.85)';
        ctx.fillText('SIGNAL MONITOR · EARTH BAND', 30, 44);
        ctx.font = 'bold 26px "Courier New", monospace';
        ctx.fillStyle = '#ffb35c';
        ctx.fillText('▲ 「快乐」 FREQ:MAX  AMP:MAX', 30, H - 28);

        self.wavesRAF = requestAnimationFrame(draw);
      };
      this.wavesRAF = requestAnimationFrame(draw);
    },

    hideWaves() {
      if (this.wavesRAF) { cancelAnimationFrame(this.wavesRAF); this.wavesRAF = null; }
      if (this.waves) { this.waves.classList.remove('show'); this.waves.hidden = true; }
    },

    finish() {
      clearInterval(this.progressTimer);
      this.timers.forEach(clearTimeout);
      this.timers = [];
      this.hideWaves();
      this.bar.style.width = '100%';
      this.el.classList.add('intro--out');
      setTimeout(() => {
        this.el.hidden = true;
        this.el.classList.remove('intro--out', 'media-fallback');
        this.img.style.opacity = '0';
        this.started = false;
        showApp();
      }, 1100);
      store.set(KEY.intro, { watched: 1 });
    }
  };

  $('#intro-skip').addEventListener('click', () => {
    sfx.select();
    intro.finish();
  });

  /* ---------------- 主界面数据 ---------------- */
  function renderStats() {
    const box = $('#stats');
    const mins = state.totalMinutes || 0;
    const hours = Math.floor(mins / 60);
    const remainMin = mins % 60;
    const dur = hours > 0 ? hours + ' 小时 ' + (remainMin ? remainMin + ' 分' : '') : mins + ' 分钟';
    box.innerHTML =
      '<div><strong>' + dur + '</strong><small>地球居留时长</small></div>' +
      '<div><strong>' + (state.success || 0) + ' 次</strong><small>成功躲藏</small></div>' +
      '<div><strong>' + (state.longestMinutes || 0) + ' 分钟</strong><small>最长一次专注</small></div>';
  }

  function showApp() {
    $('#app').hidden = false;
    requestAnimationFrame(() => $('#app').classList.add('app--in'));
    renderStats();
    setTimeout(checkLiveSession, 700);
  }

  /* ---------------- 开始专注 ----------------
   * 相位状态机：phase = 'idle' | 'focus' | 'break'
   * continuous 为 true 时：focus 成功 → break → 自动下一轮 focus，直到用户结束/失败
   */
  const focus = {
    running: false,
    phase: 'idle',
    totalMs: 0,
    endAt: 0,
    risk: 0,
    timer: null,
    hiddenAt: 0,
    minutes: 0,
    continuous: false,
    focusMin: 0,
    breakMs: 10 * 60000,
    round: 0,
    totalRounds: 0,
    cycleMinutes: 0,
    statuses: [
      '正在屏住呼吸…',
      '巷口有脚步声经过…',
      '远处传来人类的交谈声…',
      '稳住，伪装还在修复…',
      '有人的手电筒扫了过来…',
      '一动不动，再坚持一下…',
      '呼吸声太大了，小声一点…',
      '就快了，警报即将解除…'
    ],
    statusIdx: 0,
    bgmURL: null,
    bgmMode: '',
    sfxTimer: null,
    sfxEl: null
  };

  /* 专注状态音效：根据当前状态文本播放对应环境音，5 秒后停止 */
  function stopStatusSfx() {
    if (focus.sfxTimer) { clearTimeout(focus.sfxTimer); focus.sfxTimer = null; }
    if (focus.sfxEl) {
      try { focus.sfxEl.pause(); } catch (e) {}
      try { if (focus.sfxEl.readyState > 0) focus.sfxEl.currentTime = 0; } catch (e) {}
      focus.sfxEl = null;
    }
  }
  function playStatusSfx(text) {
    stopStatusSfx();
    let el = null;
    if (text === '巷口有脚步声经过…') el = $('#sfx-footsteps');
    else if (text === '远处传来人类的交谈声…') el = $('#sfx-talking');
    if (!el) return;
    try {
      if (el.readyState > 0) el.currentTime = 0;
      el.volume = 0.9;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
      focus.sfxEl = el;
      focus.sfxTimer = setTimeout(stopStatusSfx, 5000);
    } catch (e) {}
  }

  /* B站背景音乐：专注开始后注入隐藏 iframe，只听声音不显示画面 */
  function biliBgmInject(parsed) {
    if (!parsed) parsed = parseBiliId(settings.biliBgm);
    if (!parsed) return;
    const box = $('#focus-bili');
    box.innerHTML = '';
    const f = document.createElement('iframe');
    /* B站外链播放器不支持分级音量，仅 muted 0/1：滑块为 0 时静音，其余档位原声 */
    const muted = Number(settings.biliBgmVolume) === 0 ? 1 : 0;
    f.src = 'https://player.bilibili.com/player.html?' +
      (parsed.t === 'bv' ? 'bvid=' + parsed.id : 'aid=' + parsed.id) +
      '&autoplay=1&muted=' + muted + '&danmaku=0';
    f.setAttribute('frameborder', '0');
    f.setAttribute('scrolling', 'no');
    f.setAttribute('allow', 'autoplay; encrypted-media');
    box.appendChild(f);
    focus.bgmMode = 'bili';
  }

  /* B站背景音乐队列：多视频按「顺序/打乱」模式自动切换 */
  const biliQueue = { timer: null, idx: -1 };

  /* 规范化 B站链接列表：旧版为字符串数组，统一升级为 {name,url,show}；show=name|url */
  function normBiliItems() {
    const raw = (settings.biliBgmList && settings.biliBgmList.length)
      ? settings.biliBgmList
      : (settings.biliBgm ? [settings.biliBgm] : []);
    return raw.map(x => {
      if (typeof x === 'string') return { name: '', url: x, show: 'name' };
      return {
        name: (x.name != null ? String(x.name) : ''),
        url: (x.url != null ? String(x.url) : ''),
        show: x.show === 'url' ? 'url' : 'name'
      };
    });
  }
  function biliBgmIds() {
    const ids = [];
    normBiliItems().forEach(it => { const p = parseBiliId(it.url); if (p) ids.push(p); });
    return ids;
  }
  function biliBgmStopTimer() {
    if (biliQueue.timer) { clearTimeout(biliQueue.timer); biliQueue.timer = null; }
  }
  /* 查询视频时长（秒）：浏览器无法直连 B站 API（CORS/风控），逐级尝试公共代理；
     全部失败返回 null（此时按兜底间隔轮换） */
  function biliFetchDuration(item) {
    const api = 'https://api.bilibili.com/x/web-interface/view?' +
      (item.t === 'bv' ? 'bvid=' + item.id : 'aid=' + item.id);
    const urls = [
      api,
      'https://api.allorigins.win/raw?url=' + encodeURIComponent(api),
      'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(api)
    ];
    const tryFetch = (i) => {
      if (i >= urls.length) return Promise.resolve(null);
      const ctrl = ('AbortController' in window) ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 6000) : null;
      return fetch(urls[i], ctrl ? { signal: ctrl.signal } : {})
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
        .then(j => (j && j.code === 0 && j.data && j.data.duration > 0)
          ? j.data.duration : Promise.reject(new Error('bad data')))
        .catch(() => tryFetch(i + 1))
        .then(v => { if (timer) clearTimeout(timer); return v; });
    };
    return tryFetch(0);
  }
  function biliBgmPlayAt(ids, idx) {
    biliBgmStopTimer();
    biliQueue.idx = idx;
    biliBgmInject(ids[idx]);
    $('#focus-bgm').textContent = '🎵';
    $('#focus-bgm').hidden = false;
    /* 播完自动切下一首：优先按精确时长（多留 8 秒起播余量）；探测不到时长则按 4 分钟兜底轮换 */
    biliFetchDuration(ids[idx]).then(dur => {
      const wait = (dur > 0 ? dur + 8 : 240) * 1000;
      biliQueue.timer = setTimeout(() => {
        biliQueue.timer = null;
        biliBgmScheduleNext();
      }, wait);
    });
  }
  function biliBgmScheduleNext() {
    const ids = biliBgmIds();
    if (!ids.length || focus.phase === 'idle') return;
    if (settings.biliBgmMode === 'shuffle') {
      biliBgmPlayAt(ids, Math.floor(Math.random() * ids.length));
    } else {
      /* 顺序模式：从上到下依次播放，播完列表即止 */
      if (biliQueue.idx + 1 < ids.length) biliBgmPlayAt(ids, biliQueue.idx + 1);
    }
  }

  function startBgm() {
    /* 默认白噪音（雨声）独立播放，不影响 BGM 与状态音效 */
    const rain = $('#sfx-rain');
    if (settings.defaultWhiteNoise) {
      try {
        rain.volume = Math.max(0, Math.min(100, Number(settings.rainVolume) || 0)) / 100;
        const rp = rain.play();
        if (rp && rp.catch) rp.catch(() => {});
      } catch (e) {}
    }
    if (settings.biliBgmOn) {
      const ids = biliBgmIds();
      if (ids.length) {
        /* 休息结束时 iframe 仍在播（音乐贯穿休息），不重置播放，只恢复 🎵 显示 */
        if (focus.bgmMode === 'bili' && $('#focus-bili').firstChild) {
          $('#focus-bgm').textContent = '🎵';
          $('#focus-bgm').hidden = false;
          return;
        }
        const first = settings.biliBgmMode === 'shuffle'
          ? Math.floor(Math.random() * ids.length)
          : 0;
        biliBgmPlayAt(ids, first);
        return;
      }
    }
    media.get('audio').then(rec => {
      if (focus.phase !== 'focus' || !rec || !rec.blob) return;
      const a = $('#focus-audio');
      /* 休息结束时本地音频仍在播，不重置 */
      if (a.src && !a.paused) {
        $('#focus-bgm').textContent = '🎵';
        $('#focus-bgm').hidden = false;
        return;
      }
      focus.bgmURL = URL.createObjectURL(rec.blob);
      a.src = focus.bgmURL;
      a.volume = 0.45;
      a.muted = false;
      $('#focus-bgm').textContent = '🎵';
      $('#focus-bgm').hidden = false;
      a.play().catch(() => {});
    });
  }
  function stopBgm() {
    const a = $('#focus-audio');
    a.pause();
    a.removeAttribute('src');
    try { a.load(); } catch (e) {}
    $('#focus-bili').innerHTML = '';
    biliBgmStopTimer();
    biliQueue.idx = -1;
    focus.bgmMode = '';
    $('#focus-bgm').hidden = true;
    if (focus.bgmURL) { URL.revokeObjectURL(focus.bgmURL); focus.bgmURL = null; }
    /* 停止默认白噪音 */
    const rain = $('#sfx-rain');
    try { rain.pause(); rain.currentTime = 0; } catch (e) {}
  }

  function resetDurationUI() {
    $$('#duration-options button').forEach(b =>
      b.classList.toggle('active', Number(b.dataset.min) === Number(settings.defaultMin)));
    $('#custom-min').value = '';
    // 连续模式相关 UI 恢复默认：单次 + 休息 10 分钟
    $$('#continuous-seg button').forEach(b => b.classList.toggle('active', b.dataset.on === '0'));
    $('#break-options').hidden = true;
    $('#focus-duration-label').textContent = '本次躲藏时长';
    $('#continuous-hint').textContent = '撑过这一轮就安全了。';
    $$('#break-duration-options button').forEach(b =>
      b.classList.toggle('active', Number(b.dataset.min) === 10));
    $('#break-custom-min').value = '';
    $$('#round-count-options button').forEach(b =>
      b.classList.toggle('active', Number(b.dataset.rounds) === 3));
    $('#round-custom').value = '';
  }

  function chosenMinutes() {
    const custom = parseInt($('#custom-min').value, 10);
    if ($('#custom-min').value) {
      if (isNaN(custom) || custom < 1 || custom > 180) return 0;
      return custom;
    }
    const active = $('#duration-options button.active');
    return active ? Number(active.dataset.min) : Number(settings.defaultMin);
  }

  function chosenBreakMinutes() {
    const el = $('#break-custom-min');
    const custom = parseInt(el.value, 10);
    if (el.value) {
      if (isNaN(custom) || custom < 1 || custom > 60) return 0;
      return custom;
    }
    const active = $('#break-duration-options button.active');
    return active ? Number(active.dataset.min) : 10;
  }

  /* 循环轮数：0 = 不限（∞）；null = 自定义输入无效 */
  function chosenRounds() {
    const el = $('#round-custom');
    const custom = parseInt(el.value, 10);
    if (el.value) {
      if (isNaN(custom) || custom < 1 || custom > 99) return null;
      return custom;
    }
    const active = $('#round-count-options button.active');
    return active ? Number(active.dataset.rounds) : 3;
  }

  function updateContHint() {
    const r = chosenRounds();
    $('#continuous-hint').textContent = (r === 0)
      ? '一轮躲藏 + 一段休息，自动循环，直到你主动结束。'
      : '一轮躲藏 + 一段休息，自动循环 ' + r + ' 轮。';
  }

  function initDurationUI() {
    const bindGroup = (groupId, customId) => {
      const btns = $$('#' + groupId + ' button');
      const custom = $('#' + customId);
      btns.forEach(b => b.addEventListener('click', () => {
        btns.forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        custom.value = '';
        sfx.select();
      }));
      custom.addEventListener('input', () => {
        if (custom.value) btns.forEach(x => x.classList.remove('active'));
      });
    };
    bindGroup('duration-options', 'custom-min');
    bindGroup('break-duration-options', 'break-custom-min');
    bindGroup('round-count-options', 'round-custom');

    // 轮数变化时刷新提示文案（仅在连续模式下）
    const refreshRoundHint = () => {
      if ($('#continuous-seg button.active').dataset.on === '1') updateContHint();
    };
    $$('#round-count-options button').forEach(b => b.addEventListener('click', refreshRoundHint));
    $('#round-custom').addEventListener('input', refreshRoundHint);

    // 单次 / 连续 切换
    $$('#continuous-seg button').forEach(b => b.addEventListener('click', () => {
      $$('#continuous-seg button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const cont = b.dataset.on === '1';
      $('#break-options').hidden = !cont;
      $('#focus-duration-label').textContent = cont ? '每轮专注时长' : '本次躲藏时长';
      if (cont) updateContHint();
      else $('#continuous-hint').textContent = '撑过这一轮就安全了。';
      sfx.select();
    }));
  }

  function startFocus() {
    const min = chosenMinutes();
    if (!min) { toast('请输入 1–180 之间的分钟数'); return; }
    const cont = $('#continuous-seg button.active').dataset.on === '1';
    let breakMin = 10;
    let totalRounds = 0;
    if (cont) {
      breakMin = chosenBreakMinutes();
      if (!breakMin) { toast('请输入 1–60 之间的休息分钟数'); return; }
      const r = chosenRounds();
      if (r === null) { toast('请输入 1–99 之间的循环轮数'); return; }
      totalRounds = r;
    }

    closeModal('focus-setup');
    focus.continuous = cont;
    focus.focusMin = min;
    focus.breakMs = breakMin * 60000;
    focus.totalRounds = cont && totalRounds > 0 ? totalRounds : Infinity;
    focus.round = 0;
    focus.cycleMinutes = 0;
    beginFocusRound(min);
  }

  /* 进行中的专注写入本地，页面被刷新/关掉后还能接上 */
  function saveLive() {
    if (!focus.running) return;
    store.set(KEY.live, {
      endAt: focus.endAt,
      totalMs: focus.totalMs,
      minutes: focus.minutes,
      phase: focus.phase,
      continuous: focus.continuous,
      round: focus.round,
      totalRounds: focus.totalRounds === Infinity ? 0 : focus.totalRounds,
      focusMin: focus.focusMin,
      breakMs: focus.breakMs,
      cycleMinutes: focus.cycleMinutes,
      awayTotal: focus.awayTotal || 0,
      sessionStart: focus.sessionStart || Date.now(),
      savedAt: Date.now()
    });
  }
  const clearLive = () => store.remove(KEY.live);

  /* 专注界面：只负责把 DOM 画成「正在躲藏」的样子 */
  function paintFocusRun() {
    const run = $('#focus-running');
    run.hidden = false;
    run.classList.remove('is-break', 'is-bedroom');
    requestAnimationFrame(() => run.classList.add('show'));

    $('#focus-status').hidden = false;
    $('#focus-status').textContent = focus.statuses[focus.statusIdx] || focus.statuses[0];
    $('#focus-round').hidden = !focus.continuous;
    $('#focus-round').textContent = '第 ' + focus.round + ' 轮躲藏';
    $('#focus-timer').textContent = fmtTime(focus.totalMs);
    $('#focus-meter').hidden = false;
    $('#focus-meter-label').textContent = '伪装稳定度';
    $('#focus-percent').textContent = '100%';
    $('#focus-bar').style.width = '100%';
    $('#focus-risk').hidden = false;
    $('#break-tips').hidden = true;
    $('#break-actions').hidden = true;
    $('#focus-abort').hidden = false;
    renderRisk();
  }

  function startFocusTimers() {
    clearInterval(focus.timer);
    focus.timer = setInterval(tick, 250);
    clearInterval(focus.statusTimer);
    focus.statusTimer = setInterval(() => {
      focus.statusIdx = (focus.statusIdx + 1) % focus.statuses.length;
      const t = focus.statuses[focus.statusIdx];
      $('#focus-status').textContent = t;
      playStatusSfx(t);
    }, 22000);
  }

  function beginFocusRound(min) {
    focus.phase = 'focus';
    focus.running = true;
    focus.round += 1;
    $('#focus-warning').hidden = true;
    focus.minutes = min;
    focus.totalMs = min * 60000;
    focus.endAt = Date.now() + focus.totalMs;
    focus.risk = 0;
    focus.hiddenAt = 0;
    focus.awayTotal = 0;
    focus.failReason = '';
    focus.failing = false;
    if (focus.round === 1) focus.sessionStart = Date.now();
    focus.statusIdx = 0;

    paintFocusRun();
    sfx.alarm();
    document.title = '🛸 专注中 ' + fmtTime(focus.totalMs) + ' · behuman';
    startFocusTimers();
    startBgm();
    saveLive();
  }

  function beginBreak() {
    stopStatusSfx();
    focus.phase = 'break';
    focus.totalMs = focus.breakMs;
    focus.endAt = Date.now() + focus.breakMs;
    $('#focus-warning').hidden = true;

    const run = $('#focus-running');
    run.classList.add('is-break');
    $('#focus-status').textContent = '伪装稳定 · 回房间休息';
    $('#focus-round').textContent = '第 ' + focus.round + ' 轮躲藏完成';
    $('#focus-meter-label').textContent = '休息剩余';
    $('#focus-bar').style.width = '100%';
    $('#focus-percent').textContent = '100%';
    $('#focus-risk').hidden = true;
    $('#break-tips').hidden = false;
    $('#break-actions').hidden = false;
    $('#focus-abort').hidden = true;
    document.title = '☕ 休息中 ' + fmtTime(focus.breakMs) + ' · behuman';
    sfx.select();
    saveLive();
  }

  /* 回到卧室：只看房间，不跑计时、不播提示与音效 */
  function enterBedroom() {
    if (focus.running) return;
    clearInterval(focus.timer);
    clearInterval(focus.statusTimer);
    stopStatusSfx();
    focus.phase = 'bedroom';
    document.title = '卧室 · behuman';

    const run = $('#focus-running');
    run.hidden = false;
    run.classList.add('is-break', 'is-bedroom');
    requestAnimationFrame(() => run.classList.add('show'));

    $('#focus-warning').hidden = true;
    $('#focus-bgm').hidden = true;
    $('#bedroom-back').hidden = false;
    $('#bedroom-shelf').hidden = false;  /* ★★★【书架入口 · 卧室右上角】进入卧室时显示 ★★★ */
  }

  function leaveBedroom() {
    if (focus.phase !== 'bedroom') return;
    focus.phase = 'idle';
    document.title = 'behuman · 成为人类吧！';
    const run = $('#focus-running');
    run.classList.remove('show', 'is-break', 'is-bedroom');
    $('#bedroom-back').hidden = true;
    $('#bedroom-shelf').hidden = true;  /* ★★★【书架入口 · 卧室右上角】离开卧室时隐藏 ★★★ */
    setTimeout(() => {
      if (focus.phase === 'idle') run.hidden = true;
    }, 300);
  }

  function tick() {
    if (focus.failing) return;
    const remain = focus.endAt - Date.now();
    $('#focus-timer').textContent = fmtTime(remain);
    const pct = Math.max(0, remain / focus.totalMs);
    $('#focus-bar').style.width = (pct * 100).toFixed(1) + '%';
    $('#focus-percent').textContent = Math.round(pct * 100) + '%';

    if (focus.phase === 'focus') {
      document.title = '🛸 专注中 ' + fmtTime(remain) + ' · behuman';
      if (remain <= 0) completeFocusRound();
    } else {
      document.title = '☕ 休息中 ' + fmtTime(remain) + ' · behuman';
      if (remain <= 0) {
        // 休息结束，警报再次响起，自动进入下一轮
        beginFocusRound(focus.focusMin);
      }
    }
  }

  function renderRisk() {
    $$('#focus-risk i').forEach((dot, i) => dot.classList.toggle('on', i < focus.risk));
  }

  /* 一轮专注成功：记账；连续模式进入休息，单次模式收尾弹窗 */
  function completeFocusRound() {
    const min = focus.minutes;
    state.sessions = (state.sessions || 0) + 1;
    const t = today();
    if (state.days.indexOf(t) === -1) state.days.push(t);
    if (!state.daily) state.daily = {};
    state.daily[t] = (state.daily[t] || 0) + min;
    state.totalMinutes += min;
    state.success = (state.success || 0) + 1;
    state.longestMinutes = Math.max(state.longestMinutes || 0, min);
    focus.cycleMinutes += min;
    saveState();
    renderStats();
    sfx.success();
    /* 躦藏结束：在成功琶音后接一段军号收尾 */
    sfx.bugle(0.9);

    clearInterval(focus.statusTimer);
    /* 连续模式：休息时保留 B站 iframe / 本地音频 / 雨声继续播放（音乐贯穿休息），
       不调 stopBgm；真正结束（endFocus / 单次模式）才销毁 */
    if (focus.continuous) {
      // 已完成设定轮数：直接结算，不再进入休息
      if (focus.round >= focus.totalRounds) { endFocus(true); return; }
      beginBreak();
    } else {
      endFocus(true);
    }
    stopStatusSfx();
  }

  function endFocus(success, aborted) {
    if (!focus.running) return;
    const wasContinuous = focus.continuous;
    const cycleRounds = focus.round;
    const cycleMins = focus.cycleMinutes;
    focus.running = false;
    focus.failing = false;
    focus.phase = 'idle';
    clearInterval(focus.timer);
    clearInterval(focus.statusTimer);
    stopBgm();
    stopStatusSfx();
    clearLive();
    document.title = 'behuman · 成为人类吧！';

    const run = $('#focus-running');
    run.classList.remove('show', 'is-break');
    setTimeout(() => { run.hidden = true; }, 300);

    if (!success) {
      state.failed = (state.failed || 0) + 1;
      state.interruptions = (state.interruptions || 0) + 1;
      saveState();
      sfx.fail();
    }
    renderStats();
    const recMins = success ? (wasContinuous ? cycleMins : focus.minutes) : cycleMins;
    pushHistory({
      at: Date.now(),
      mins: recMins,
      ok: !!success,
      rounds: cycleRounds,
      reason: focus.failReason || (aborted ? 'abort' : (success ? 'done' : 'caught'))
    });
    focus.failReason = '';
    showResult(success, success ? (wasContinuous ? cycleMins : focus.minutes) : 0, aborted,
      { continuous: wasContinuous, rounds: cycleRounds, cycleMins: cycleMins });

    // 重置连续序列
    focus.continuous = false;
    focus.round = 0;
    focus.totalRounds = 0;
    focus.cycleMinutes = 0;
    focus.focusMin = 0;
  }

  function showResult(ok, minutes, aborted, extra) {
    const title = $('#result-title');
    const emoji = $('#result-emoji');
    const text = $('#result-text');
    const grid = $('#result-grid');
    const cont = extra && extra.continuous;

    if (ok) {
      if (cont) {
        title.textContent = '连续躲藏结束';
        emoji.textContent = '🌍';
        text.textContent = '你在人群中藏了一轮又一轮，这些屏住呼吸的时间，都换成了留在地球的资格。';
        grid.innerHTML =
          '<div><strong>' + extra.rounds + ' 轮</strong><small>本次连续</small></div>' +
          '<div><strong>' + minutes + ' 分钟</strong><small>本次躲藏合计</small></div>' +
          '<div><strong>' + (state.totalMinutes || 0) + ' 分钟</strong><small>累计居留</small></div>';
      } else {
        title.textContent = '暂时安全了';
        emoji.textContent = '🛸';
        const praises = [
          '你完美地屏住了呼吸，没有一个人类发现异常。',
          '伪装重新稳定下来——今天，你又是一个「普通人类」了。',
          '好险！人群散去，你成功撑过了这次变身。'
        ];
        text.textContent = praises[Math.floor(Math.random() * praises.length)];
        grid.innerHTML =
          '<div><strong>' + minutes + ' 分钟</strong><small>本次躲藏</small></div>' +
          '<div><strong>' + (state.totalMinutes || 0) + ' 分钟</strong><small>累计居留</small></div>' +
          '<div><strong>' + (state.success || 0) + ' 次</strong><small>成功次数</small></div>';
      }
    } else {
      title.textContent = aborted ? '你选择了现形' : '被发现了！';
      emoji.textContent = aborted ? '🌫️' : '👁️';
      text.textContent = aborted
        ? '你提前离开了躲藏点，伪装在人群面前消散……这一轮不会计入居留时长，下一次藏久一点。'
        : '你离开页面的时间太久，被路过的人类看到了原型！本次专注失败，深呼吸，再来一次。';
      if (cont) {
        grid.innerHTML =
          '<div><strong>' + extra.cycleMins + ' 分钟</strong><small>此前轮次已居留</small></div>' +
          '<div><strong>' + Math.max(0, extra.rounds - 1) + ' 轮</strong><small>已完成轮数</small></div>' +
          '<div><strong>' + (state.failed || 0) + ' 次</strong><small>暴露次数</small></div>';
      } else {
        grid.innerHTML =
          '<div><strong>0 分钟</strong><small>本次居留</small></div>' +
          '<div><strong>' + (state.failed || 0) + ' 次</strong><small>暴露次数</small></div>' +
          '<div><strong>' + (state.success || 0) + ' 次</strong><small>成功次数</small></div>';
      }
    }
    openModal('focus-result');
  }

  document.addEventListener('visibilitychange', () => {
    if (!focus.running || focus.phase !== 'focus' || focus.failing) return;
    if (document.hidden) {
      focus.hiddenAt = Date.now();
      return;
    }
    if (!focus.hiddenAt) return;
    const awaySec = Math.max(0, Math.round((Date.now() - focus.hiddenAt) / 1000));
    focus.hiddenAt = 0;
    if (!awaySec) return;
    /* 离开的时间不计入专注，但累计起来用于判定，避免「反复切 14 秒」把计时无限拖长 */
    focus.awayTotal = (focus.awayTotal || 0) + awaySec;
    focus.endAt += awaySec * 1000;
    saveLive();

    const fail = (reason, msg) => {
      focus.failReason = reason;
      focus.failing = true;
      $('#focus-warning-text').innerHTML = msg;
      $('#focus-warning').hidden = false;
      sfx.alarm();
      setTimeout(() => {
        $('#focus-warning').hidden = true;
        if (focus.running) endFocus(false, false);
      }, 900);
    };

    if (settings.strictMode) {
      if (awaySec >= 3 || focus.awayTotal >= 10) {
        fail('strict', '严格模式：你离开了 <strong>' + awaySec + '</strong> 秒（累计 ' + focus.awayTotal + ' 秒），伪装直接失效。');
      }
      return;
    }

    if (awaySec >= 15) {
      focus.risk += 1;
      renderRisk();
      $('#focus-warning-text').innerHTML =
        '你离开页面 <strong>' + awaySec + '</strong> 秒，巷口的人类差点发现你！<br/>第 ' +
        focus.risk + ' 次暴露风险（累计 3 次任务失败），累计离开 ' + focus.awayTotal + ' 秒。';
      $('#focus-warning').hidden = false;
      sfx.alarm();
      if (focus.risk >= 3) {
        fail('caught', '第三次暴露风险，伪装彻底失效。');
        return;
      }
    }
    if (focus.awayTotal >= 180) {
      fail('away', '你累计离开页面 <strong>' + focus.awayTotal + '</strong> 秒，超过 3 分钟，伪装失效。');
    }
  });

  $('#focus-warning-back').addEventListener('click', () => {
    $('#focus-warning').hidden = true;
    sfx.select();
  });

  $('#focus-abort').addEventListener('click', () => {
    const msg = focus.continuous
      ? '提前现形将结束本次连续专注，当前这一轮不计入居留时长（已完成 ' +
        Math.max(0, focus.round - 1) + ' 轮）。确定放弃吗？'
      : '提前现形意味着本次专注失败，且不计入居留时长。确定放弃吗？';
    if (confirm(msg)) {
      endFocus(false, true);
    }
  });

  $('#break-skip').addEventListener('click', () => {
    if (focus.phase !== 'break') return;
    sfx.select();
    beginFocusRound(focus.focusMin);
  });

  $('#break-end').addEventListener('click', () => {
    if (focus.phase !== 'break') return;
    if (confirm('已完成 ' + focus.round + ' 轮躲藏，确定结束本次连续专注吗？')) {
      endFocus(true);
    }
  });

  $('#focus-bgm').addEventListener('click', () => {
    if (focus.bgmMode === 'bili') {
      const box = $('#focus-bili');
      if (box.firstChild) {
        box.innerHTML = '';
        biliBgmStopTimer();
        $('#focus-bgm').textContent = '🔇';
      } else {
        const ids = biliBgmIds();
        const at = (biliQueue.idx >= 0 && biliQueue.idx < ids.length) ? biliQueue.idx : 0;
        if (ids.length) biliBgmPlayAt(ids, at);
      }
      return;
    }
    const a = $('#focus-audio');
    if (a.paused) {
      a.muted = false;
      a.play().catch(() => {});
      $('#focus-bgm').textContent = '🎵';
    } else {
      a.muted = !a.muted;
      $('#focus-bgm').textContent = a.muted ? '🔇' : '🎵';
    }
  });

  $('#focus-start').addEventListener('click', startFocus);
  $('#result-back').addEventListener('click', () => { closeModal('focus-result'); sfx.select(); });

  /* ---------------- 设置 ---------------- */
  function syncSettingsUI() {
    $('#set-default-min').value = String(settings.defaultMin);
    $('#set-sound').checked = !!settings.sound;
    $('#set-strict').checked = !!settings.strictMode;
    $('#set-rain').checked = !!settings.defaultWhiteNoise;
    $('#set-rain-vol').value = String(settings.rainVolume);
    $('#set-rain-vol-val').textContent = String(settings.rainVolume);
    $('#set-bili-bgm-on').checked = !!settings.biliBgmOn;
    $('#set-bili-vol').value = String(settings.biliBgmVolume);
    $('#set-bili-vol-val').textContent = String(settings.biliBgmVolume);
    renderBiliList();
    syncBiliModeUI();
    syncMediaUI();
  }

  function mediaLabel(rec, emptyText) {
    if (!rec) return emptyText;
    return rec.name + '（' + fmtSize(rec.size) + '）';
  }
  function syncMediaUI() {
    media.get('audio').then(rec => {
      $('#set-audio-name').textContent = mediaLabel(rec, '未导入 · 专注时无背景音乐');
      $('#set-audio-clear').hidden = !rec;
    });
  }

  function bindMediaImport(btnId, inputId, clearId, key, maxMB) {
    const input = $('#' + inputId);
    $('#' + btnId).addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      if (file.type && file.type.indexOf('audio/') !== 0) {
        toast('请选择音频文件');
        return;
      }
      if (file.size > maxMB * 1024 * 1024) {
        if (!confirm('文件较大（' + fmtSize(file.size) + '），保存后会占用本机浏览器存储空间，确定导入吗？')) return;
      }
      toast('正在导入…');
      media.put(key, file).then(() => {
        syncMediaUI();
        toast('导入成功');
        sfx.success();
      }).catch(() => toast('导入失败：浏览器存储空间不足或不可用'));
    });
    $('#' + clearId).addEventListener('click', () => {
      if (!confirm('移除已导入的音频？')) return;
      media.del(key).then(() => {
        syncMediaUI();
        toast('已移除');
      });
    });
  }
  bindMediaImport('set-audio-btn', 'set-audio-file', 'set-audio-clear', 'audio', 100);

  /* ---------------- B站背景音乐设置（多链接命名/排序 + 播放模式） ---------------- */
  const BILI_MODE_HINTS = {
    seq: '按列表从上到下依次播放，播完即止。',
    shuffle: '每首播完后，随机跳到列表中的任意一首，直到专注结束。'
  };
  function syncBiliModeUI() {
    const mode = settings.biliBgmMode === 'shuffle' ? 'shuffle' : 'seq';
    $$('#bili-mode-seg button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    $('#bili-mode-hint').textContent = BILI_MODE_HINTS[mode];
  }
  function collectBiliList() {
    return $$('#bili-list .bili-card').map(card => ({
      name: $('.bili-edit__name', card).value.trim(),
      url: $('.bili-edit__url', card).value.trim(),
      show: card._data.show
    })).filter(it => it.name || it.url);
  }
  function saveBiliList() {
    settings.biliBgmList = collectBiliList();
    saveSettings();
  }
  /* 折叠态显示文本：按 show 取名称或网址，缺省互相回退；全空返回占位 */
  function biliLabelText(d) {
    const name = d.name.trim(), url = d.url.trim();
    if (d.show === 'name') return { text: name || url, empty: !(name || url) };
    return { text: url || name, empty: !(name || url) };
  }
  function makeBiliCard(data) {
    const card = document.createElement('div');
    card.className = 'bili-card';
    card._data = data;
    card.innerHTML =
      '<div class="bili-item">' +
        '<span class="bili-item__grip" title="点击编辑名称 / 按住拖动排序">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
        '</span>' +
        '<button type="button" class="bili-item__label"></button>' +
        '<span class="bili-item__move">' +
          '<button type="button" class="bili-item__up" title="上移" aria-label="上移">↑</button>' +
          '<button type="button" class="bili-item__down" title="下移" aria-label="下移">↓</button>' +
        '</span>' +
        '<button type="button" class="bili-item__del" title="移除">×</button>' +
      '</div>' +
      '<div class="bili-edit" hidden>' +
        '<label class="bili-edit__field"><span>名称</span>' +
          '<input type="text" class="bili-edit__name" maxlength="40" placeholder="给这段声音起个名字，如：雨夜白噪音" /></label>' +
        '<label class="bili-edit__field"><span>链接</span>' +
          '<input type="text" class="bili-edit__url" placeholder="https://www.bilibili.com/video/BV…" maxlength="120" /></label>' +
        '<div class="bili-edit__bottom"><div class="seg bili-edit__seg">' +
          '<button type="button" data-show="name">显示名称</button>' +
          '<button type="button" data-show="url">显示网址</button>' +
        '</div></div>' +
      '</div>';

    const nameInput = $('.bili-edit__name', card);
    const urlInput = $('.bili-edit__url', card);
    const labelBtn = $('.bili-item__label', card);
    const editPanel = $('.bili-edit', card);
    nameInput.value = data.name;
    urlInput.value = data.url;

    const refreshLabel = () => {
      const L = biliLabelText(card._data);
      labelBtn.textContent = L.empty ? '未设置链接 · 点击左侧图标编辑' : L.text;
      labelBtn.classList.toggle('is-empty', L.empty);
    };
    const refreshSeg = () => {
      $$('.bili-edit__seg button', card).forEach(b =>
        b.classList.toggle('active', b.dataset.show === card._data.show));
    };
    refreshLabel();
    refreshSeg();

    /* 点击三杠（或标签）展开/收起命名面板 */
    const setExpanded = (open) => {
      editPanel.hidden = !open;
      card.classList.toggle('bili-card--open', open);
    };
    let dragMoved = false;
    $('.bili-item__grip', card).addEventListener('click', () => {
      if (!dragMoved) setExpanded(editPanel.hidden);
    });
    labelBtn.addEventListener('click', () => setExpanded(editPanel.hidden));

    /* 编辑即保存；任何卡片填入有效链接后，若列表中没有空白栏则自动追加（上限 10 个） */
    const onInput = () => {
      card._data.name = nameInput.value;
      card._data.url = urlInput.value;
      refreshLabel();
      if (parseBiliId(urlInput.value)) {
        const cards = $$('#bili-list .bili-card');
        const hasEmpty = cards.some(c => !parseBiliId($('.bili-edit__url', c).value));
        if (!hasEmpty && cards.length < 10) {
          $('#bili-list').appendChild(makeBiliCard({ name: '', url: '', show: 'name' }));
        }
      }
      saveBiliList();
    };
    nameInput.addEventListener('input', onInput);
    urlInput.addEventListener('input', onInput);

    /* 折叠态显示：自主名称 或 网址 */
    $$('.bili-edit__seg button', card).forEach(b => b.addEventListener('click', () => {
      card._data.show = b.dataset.show;
      refreshSeg();
      refreshLabel();
      saveBiliList();
      sfx.select();
    }));

    $('.bili-item__del', card).addEventListener('click', () => {
      card.remove();
      if (!$('#bili-list .bili-card')) {
        $('#bili-list').appendChild(makeBiliCard({ name: '', url: '', show: 'name' }));
      }
      saveBiliList();
      sfx.select();
    });

    /* 上下移动：触屏与键盘都能用，补足拖拽排序在手机上的缺失 */
    const moveCard = (dir) => {
      const sib = dir < 0 ? card.previousElementSibling : card.nextElementSibling;
      if (!sib) return;
      if (dir < 0) sib.before(card); else sib.after(card);
      saveBiliList();
      sfx.select();
    };
    $('.bili-item__up', card).addEventListener('click', () => moveCard(-1));
    $('.bili-item__down', card).addEventListener('click', () => moveCard(1));

    /* 拖动排序：按住三杠才允许拖，与点击展开区分；真实拖动后抑制本次 click */
    const grip = $('.bili-item__grip', card);
    grip.addEventListener('mousedown', () => { card.draggable = true; });
    card.addEventListener('dragstart', (e) => {
      if (!card.draggable) { e.preventDefault(); return; }
      dragMoved = true;
      card.classList.add('bili-card--dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', 'bili'); } catch (err) {}
    });
    card.addEventListener('dragover', (e) => {
      const dragging = $('#bili-list .bili-card--dragging');
      if (!dragging || dragging === card) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = card.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      $('#bili-list').insertBefore(dragging, before ? card : card.nextSibling);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('bili-card--dragging');
      card.draggable = false;
      saveBiliList();
      setTimeout(() => { dragMoved = false; }, 0);
    });
    return card;
  }
  function renderBiliList() {
    const box = $('#bili-list');
    box.innerHTML = '';
    const list = normBiliItems();
    if (!list.length) list.push({ name: '', url: '', show: 'name' });
    list.forEach(d => box.appendChild(makeBiliCard(d)));
  }
  /* 松开鼠标后恢复卡片不可拖状态（拖动手柄 mousedown 时才临时开启） */
  document.addEventListener('mouseup', () => {
    $$('#bili-list .bili-card').forEach(c => { c.draggable = false; });
  });
  $$('#bili-mode-seg button').forEach(b => b.addEventListener('click', () => {
    settings.biliBgmMode = b.dataset.mode;
    saveSettings();
    syncBiliModeUI();
    if (settings.sound) sfx.select();
  }));
  $('#set-default-min').addEventListener('change', (e) => {
    settings.defaultMin = Number(e.target.value);
    saveSettings();
    toast('默认专注时长已更新');
  });
  $('#set-sound').addEventListener('change', (e) => {
    settings.sound = e.target.checked;
    saveSettings();
    if (settings.sound) sfx.select();
  });
  $('#set-strict').addEventListener('change', (e) => {
    settings.strictMode = e.target.checked;
    saveSettings();
    if (settings.sound) sfx.select();
    toast(settings.strictMode ? '严格模式已开启：离开 3 秒即失败' : '已切回宽松模式：累计离开 3 分钟失败');
  });
  $('#set-rain').addEventListener('change', (e) => {
    settings.defaultWhiteNoise = e.target.checked;
    saveSettings();
    if (settings.sound) sfx.select();
  });
  $('#set-rain-vol').addEventListener('input', (e) => {
    const v = Number(e.target.value) || 0;
    settings.rainVolume = v;
    $('#set-rain-vol-val').textContent = String(v);
    saveSettings();
  });
  $('#set-bili-bgm-on').addEventListener('change', (e) => {
    settings.biliBgmOn = e.target.checked;
    saveSettings();
    if (settings.sound) sfx.select();
  });
  $('#set-bili-vol').addEventListener('input', (e) => {
    const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    settings.biliBgmVolume = v;
    $('#set-bili-vol-val').textContent = String(v);
    saveSettings();
  });
  $('#set-replay').addEventListener('click', () => {
    closeModal('modal-settings');
    store.remove(KEY.intro);
    intro.timers.forEach(clearTimeout);
    intro.timers = [];
    clearInterval(intro.progressTimer);
    intro.started = false;
    intro.bar.style.width = '0%';
    intro.play();
  });
  $('#set-clear').addEventListener('click', () => {
    const who = accountName ? '当前账号（' + accountName + '）的' : '本机的';
    if (!confirm('将清空' + who + '全部专注记录与设置，且无法恢复。确定吗？')) return;
    if (!confirm('真的要让外星人忘记在地球上的一切吗？')) return;
    Object.keys(KEY).forEach(k => store.remove(KEY[k]));
    media.clear();
    state = freshState();
    settings = Object.assign({}, SETTINGS_DEFAULT);
    renderStats();
    syncSettingsUI();
    renderAccountUI();
    closeModal('modal-settings');
    toast('所有数据已清空（含导入的音频与视频）');
  });

  /* ---------------- 数据导出 / 导入 ---------------- */
  function exportData() {
    const payload = {
      app: 'behuman',
      version: 2.49,
      exportedAt: new Date().toISOString(),
      account: accountName || '',
      state: state,
      settings: settings,
      notes: store.get(KEY.notes, []),
      profile: store.get(KEY.profile, {})
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'behuman-backup-' + today() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    sfx.success();
    toast('备份已导出，妥善保存');
  }
  $('#data-export').addEventListener('click', exportData);
  $('#data-import').addEventListener('click', () => $('#data-import-file').click());
  $('#data-import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(String(reader.result)); } catch (err) { toast('文件不是有效的 JSON'); return; }
      if (!data || data.app !== 'behuman' || !data.state || typeof data.state !== 'object' || Array.isArray(data.state)) {
        toast('这不是 behuman 的备份文件');
        return;
      }
      if (!confirm('导入会覆盖当前身份的记录、设置与日记，确定继续吗？')) return;
      const nextState = Object.assign(freshState(), data.state);
      if (!nextState.daily || typeof nextState.daily !== 'object') nextState.daily = {};
      if (!Array.isArray(nextState.history)) nextState.history = [];
      store.set(KEY.state, nextState);
      store.set(KEY.settings, Object.assign({}, SETTINGS_DEFAULT, data.settings || {}));
      if (Array.isArray(data.notes)) store.set(KEY.notes, data.notes);
      if (data.profile) store.set(KEY.profile, data.profile);
      state = nextState;
      settings = Object.assign({}, SETTINGS_DEFAULT, data.settings || {});
      renderStats();
      syncSettingsUI();
      renderAccountUI();
      sfx.success();
      toast('导入完成');
    };
    reader.readAsText(file);
  });

  /* ---------------- 意见反馈（通过 FormSubmit 转发到邮箱） ---------------- */
  const FB_ENDPOINT = 'https://formsubmit.co/ajax/emmhuyalan@qq.com';
  const fbContent = $('#fb-content');
  fbContent.addEventListener('input', () => { $('#fb-count').textContent = fbContent.value.length; });

  $('#feedback-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = fbContent.value.trim();
    if (!content) { toast('请先写下反馈内容'); return; }
    const contact = $('#fb-contact').value.trim();
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
    const submitBtn = $('#fb-submit');
    const okEl = $('#fb-ok');
    const errEl = $('#fb-err');
    okEl.hidden = true;
    errEl.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = '正在发送…';

    // 本地留存一份，防止网络异常丢失
    const list = store.get(KEY.feedback, []);
    list.push({ content: content, contact: contact, at: new Date().toISOString() });
    store.set(KEY.feedback, list);

    const payload = {
      _subject: '【behuman 网站反馈】' + new Date().toLocaleString('zh-CN'),
      _captcha: 'false',
      _template: 'table',
      _honey: '',
      name: contact || '匿名访客',
      联系方式: contact || '未填写',
      反馈内容: content,
      提交时间: fmtDate(new Date().toISOString()),
      来源页面: location.href,
      浏览器: navigator.userAgent,
      message: '反馈内容：\n' + content + '\n\n联系方式：' + (contact || '未填写') +
        '\n提交时间：' + fmtDate(new Date().toISOString()) + '\n来源页面：' + location.href
    };
    if (isEmail) payload.email = contact;

    let delivered = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(FB_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      delivered = res.ok;
      if (!delivered) errEl.textContent = '发送失败（HTTP ' + res.status + '），内容已暂存在本机，请稍后再试。';
    } catch (err) {
      delivered = false;
      errEl.textContent = '发送失败：当前网络无法连接邮件服务，内容已暂存在本机，请稍后再试。';
    }

    submitBtn.disabled = false;
    submitBtn.textContent = '发送信号';
    if (delivered) {
      okEl.hidden = false;
      sfx.success();
      setTimeout(() => {
        okEl.hidden = true;
        e.target.reset();
        $('#fb-count').textContent = '0';
        closeModal('modal-feedback');
      }, 1600);
    } else {
      errEl.hidden = false;
    }
  });

  /* ****************************************************************
   * ★★★【书架模块】开始★★★
   * 书架渲染 / 翻开的书本弹窗（阅读·研究笔记）/ 文章分页翻页 / 日记随笔
   * 配套：index.html「【书架模块 · 弹窗结构】」
   *       css/style.css「【书架模块】」
   *       js/articles.js（文章正文数据源 window.BH_ARTICLES）
   * 注意：v2.36 起主菜单已移除书架入口，本模块保留备用
   * **************************************************************** */
  const BOOK_ARTICLES = Array.isArray(window.BH_ARTICLES) ? window.BH_ARTICLES : [];
  const BOOK_COLORS = ['#7d3a30', '#2f5a5e', '#5c4877', '#8a6224', '#36507a', '#6a3d52'];
  const bookState = {
    view: 'menu',        // menu | list | reader | notebook
    article: null,
    pages: [],
    spread: 0,
    notes: [],
    noteIdx: 0,
    flipping: false
  };
  let noteSaveTimer = null;
  let bookResizeTimer = null;

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  const isNarrowBook = () => window.matchMedia('(max-width: 760px)').matches;

  /* ---------- 书架外观 ---------- */
  function renderShelf() {
    const box = $('#shelf-books');
    if (!box) return;
    let html = '';
    BOOK_ARTICLES.forEach((a, i) => {
      const h = 58 + ((i * 17) % 30);
      html += '<button class="book-spine" type="button" data-book="' + i +
        '" style="--spine:' + BOOK_COLORS[i % BOOK_COLORS.length] + ';--h:' + h + 'px" title="' +
        escHtml(a.title) + '"><span>' + escHtml(a.title) + '</span></button>';
    });
    html += '<button class="book-spine book-spine--note" type="button" data-book="note"' +
      ' style="--spine:#1f5f6b;--h:78px" title="日记 · 随笔"><span>日记 · 随笔</span></button>';
    box.innerHTML = html;
  }

  /* ---------- 书本通用 ---------- */
  function setBookHeads(left, right) {
    $('#book-head-left').textContent = left || '';
    $('#book-head-right').textContent = right || '';
  }
  function setNoteMode(on) {
    $('#book').classList.toggle('book--note', on);
    $('#book-note').hidden = !on;
    if (on) {
      $('#book-left').innerHTML = '';
      $('#book-right').innerHTML = '';
    }
  }
  function setBar(o) {
    const prev = $('#book-prev'), next = $('#book-next'), info = $('#book-pageinfo');
    const back = $('#book-back'), add = $('#book-new');
    prev.hidden = !o.nav; next.hidden = !o.nav;
    prev.disabled = !!(o.nav && o.prevDisabled);
    next.disabled = !!(o.nav && o.nextDisabled);
    info.hidden = !o.info;
    info.textContent = o.info || '';
    back.hidden = !o.back;
    add.hidden = !o.add;
  }

  /* ---------- 打开 / 封面（阅读与书写） ---------- */
  function openBook() {
    bookState.flipping = false;
    renderBookMenu();
    openModal('modal-book');
  }
  function renderBookMenu() {
    bookState.view = 'menu';
    setNoteMode(false);
    setBookHeads('', '');
    $('#book-left').innerHTML =
      '<div class="book-cover">' +
        '<p class="book-cover__kicker">书 架</p>' +
        '<h3 class="book-cover__title">躲藏者手记</h3>' +
        '<p class="book-cover__quote">来都来了，研究（人类）还是有必要的......</p>' +
        '<span class="book-cover__meta">BE&nbsp;HUMAN&nbsp;·&nbsp;读&nbsp;/&nbsp;写</span>' +
      '</div>';
    $('#book-right').innerHTML =
      '<div class="book-choice-wrap">' +
        '<button class="book-choice" type="button" data-choice="read">' +
          '<strong>阅读</strong><small>翻开已收入书架的文章</small></button>' +
        '<button class="book-choice" type="button" data-choice="write">' +
          '<strong>研究笔记</strong><small>在横线本上记下今天</small></button>' +
      '</div>';
    setBar({ nav: false, back: false });
  }

  /* ---------- 文章目录 ---------- */
  function renderArticleList() {
    bookState.view = 'list';
    setNoteMode(false);
    setBookHeads('', '');
    const count = BOOK_ARTICLES.length;
    $('#book-left').innerHTML =
      '<div class="book-cover">' +
        '<p class="book-cover__kicker">阅 读</p>' +
        '<h3 class="book-cover__title">奇怪的书籍</h3>' +
        '<p class="book-cover__quote">这里似乎有一些地球上从未出现过的书。</p>' +
      '</div>';
    if (!count) {
      $('#book-right').innerHTML =
        '<p class="book-list__empty">书架里还没有文章。<br/>把 Word 文档放进「素材 / 文章」后，<br/>重新生成文章数据即可。</p>';
    } else {
      let html = '<div class="book-list">';
      BOOK_ARTICLES.forEach((a, i) => {
        const len = (a.paragraphs || []).join('').replace(/\s/g, '').length;
        html += '<button class="book-list__item" type="button" data-article="' + i + '">' +
          '<strong>' + escHtml(a.title) + '</strong><small>' + len + ' 字</small></button>';
      });
      html += '</div>';
      $('#book-right').innerHTML = html;
    }
    setBar({ nav: false, back: true });
  }

  /* ---------- 阅读：分页 ---------- */
  function splitBlocks(article) {
    const out = [];
    (article.paragraphs || []).forEach(p => {
      const text = String(p || '').replace(/\r/g, '').trim();
      if (!text) { out.push(''); return; }
      const parts = text.match(/[^。！？；!?;]+[。！？；!?;]?/g) || [text];
      parts.forEach(s => { s = s.trim(); if (s) out.push(s); });
    });
    return out;
  }
  function paginateArticle(article) {
    const el = $('#book-right');
    el.innerHTML = '';
    const maxH = el.clientHeight || 400;
    const blocks = splitBlocks(article);
    const pages = [];
    let cur = [];
    const renderCur = () => {
      el.innerHTML = cur.map(t => t
        ? '<p class="book-p">' + escHtml(t) + '</p>'
        : '<p class="book-p book-p--empty">&#8203;</p>').join('');
    };
    let i = 0;
    while (i < blocks.length) {
      cur.push(blocks[i]);
      renderCur();
      if (el.scrollHeight <= maxH) { i++; continue; }
      cur.pop();
      renderCur();
      if (cur.length) { pages.push(cur); cur = []; continue; }
      /* 单个段落超过一页：按字符拆分 */
      let rest = blocks[i] || ' ';
      while (rest.length) {
        let lo = 1, hi = rest.length, best = 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          el.innerHTML = '<p class="book-p">' + escHtml(rest.slice(0, mid)) + '</p>';
          if (el.scrollHeight <= maxH) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        const head = rest.slice(0, best);
        rest = rest.slice(best);
        if (rest) pages.push([head]); else cur = [head];
      }
      i++;
    }
    if (cur.length) pages.push(cur);
    el.innerHTML = '';
    return pages.length ? pages : [['']];
  }
  function openReader(idx) {
    const a = BOOK_ARTICLES[idx];
    if (!a) return;
    bookState.view = 'reader';
    bookState.article = a;
    bookState.spread = 0;
    setNoteMode(false);
    setBookHeads(a.title, a.title);
    bookState.pages = paginateArticle(a);
    renderReader();
  }
  function renderReader() {
    const narrow = isNarrowBook();
    const per = narrow ? 1 : 2;
    const start = bookState.spread * per;
    const pageHTML = pg => (pg || []).map(t => t
      ? '<p class="book-p">' + escHtml(t) + '</p>'
      : '<p class="book-p book-p--empty">&#8203;</p>').join('');
    $('#book-left').innerHTML = narrow ? '' : pageHTML(bookState.pages[start]);
    $('#book-right').innerHTML = pageHTML(bookState.pages[narrow ? start : start + 1]);
    const total = bookState.pages.length;
    const spreadCount = Math.ceil(total / per);
    const a = start + 1, b = Math.min(start + per, total);
    setBar({
      nav: true,
      back: true,
      prevDisabled: bookState.spread <= 0,
      nextDisabled: bookState.spread >= spreadCount - 1,
      info: '第 ' + a + (b > a ? '–' + b : '') + ' 页 / 共 ' + total + ' 页'
    });
  }
  function turnBook(dir) {
    if (bookState.view !== 'reader' || bookState.flipping) return;
    const narrow = isNarrowBook();
    const per = narrow ? 1 : 2;
    const spreadCount = Math.ceil(bookState.pages.length / per);
    if (dir > 0 && bookState.spread >= spreadCount - 1) return;
    if (dir < 0 && bookState.spread <= 0) return;
    const flip = $('#book-flip');
    const inner = $('#book-flip-inner');
    const useRight = dir > 0 || narrow;
    inner.innerHTML = $(useRight ? '#book-right' : '#book-left').innerHTML;
    flip.className = 'book__flip ' + (useRight ? 'is-right' : 'is-left');
    flip.hidden = false;
    flip.style.animation = 'none';
    void flip.offsetWidth;
    flip.style.animation = (dir > 0 ? 'pageTurnNext' : 'pageTurnPrev') + ' 0.62s ease-in-out forwards';
    bookState.flipping = true;
    bookState.spread += dir;
    renderReader();
    setTimeout(() => {
      flip.hidden = true;
      flip.style.animation = '';
      flip.className = 'book__flip';
      bookState.flipping = false;
    }, 640);
  }

  /* ---------- 书写：横线笔记本 ---------- */
  function loadNotes() {
    const raw = store.get(KEY.notes, []);
    bookState.notes = Array.isArray(raw)
      ? raw.filter(n => n && typeof n === 'object' && typeof n.text === 'string')
      : [];
  }
  function saveNotes() { store.set(KEY.notes, bookState.notes); }
  function newNote() {
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: today(),
      text: '',
      updatedAt: new Date().toISOString()
    };
  }
  function renderNotebook() {
    bookState.view = 'notebook';
    setNoteMode(true);
    loadNotes();
    if (!bookState.notes.length) {
      bookState.notes.push(newNote());
      saveNotes();
    }
    bookState.noteIdx = bookState.notes.length - 1;
    renderNotePage();
  }
  function renderNotePage() {
    const n = bookState.notes[bookState.noteIdx];
    if (!n) return;
    setBookHeads('', '');
    $('#note-date').textContent = n.date || '';
    $('#note-text').value = n.text || '';
    $('#note-save').textContent = '自动保存';
    setBar({
      nav: true,
      back: true,
      add: true,
      prevDisabled: bookState.noteIdx <= 0,
      nextDisabled: bookState.noteIdx >= bookState.notes.length - 1,
      info: '第 ' + (bookState.noteIdx + 1) + ' / ' + bookState.notes.length + ' 篇'
    });
    setTimeout(() => {
      if (bookState.view === 'notebook') $('#note-text').focus();
    }, 60);
  }
  function moveNote(dir) {
    const i = bookState.noteIdx + dir;
    if (i < 0 || i >= bookState.notes.length) return;
    bookState.noteIdx = i;
    renderNotePage();
  }
  function addNote() {
    const cur = bookState.notes[bookState.noteIdx];
    if (cur && !cur.text.trim()) {
      $('#note-text').focus();
      toast('这一页还是空的，先写点什么吧');
      return;
    }
    bookState.notes.push(newNote());
    saveNotes();
    bookState.noteIdx = bookState.notes.length - 1;
    renderNotePage();
    sfx.select();
  }
  function bookOnAccountChanged() {
    bookState.notes = [];
    bookState.noteIdx = 0;
  }

  /* ---------- 事件绑定 ---------- */
  $('#modal-book').addEventListener('click', (e) => {
    const choice = e.target.closest('[data-choice]');
    if (choice) {
      if (choice.dataset.choice === 'read') renderArticleList();
      else renderNotebook();
      return;
    }
    const item = e.target.closest('[data-article]');
    if (item) openReader(Number(item.dataset.article));
  });
  $('#book-prev').addEventListener('click', () => {
    if (bookState.view === 'reader') turnBook(-1);
    else if (bookState.view === 'notebook') moveNote(-1);
  });
  $('#book-next').addEventListener('click', () => {
    if (bookState.view === 'reader') turnBook(1);
    else if (bookState.view === 'notebook') moveNote(1);
  });
  $('#book-back').addEventListener('click', () => renderBookMenu());
  $('#book-new').addEventListener('click', addNote);
  $('#note-text').addEventListener('input', (e) => {
    const n = bookState.notes[bookState.noteIdx];
    if (!n) return;
    n.text = e.target.value;
    n.updatedAt = new Date().toISOString();
    $('#note-save').textContent = '正在保存…';
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(() => {
      saveNotes();
      $('#note-save').textContent = '已保存';
    }, 350);
  });
  $('#note-text').addEventListener('blur', () => {
    clearTimeout(noteSaveTimer);
    saveNotes();
    $('#note-save').textContent = '已保存';
  });
  $('.book-close').addEventListener('click', () => {
    clearTimeout(noteSaveTimer);
    if (bookState.view === 'notebook') saveNotes();
  });
  window.addEventListener('resize', () => {
    if (bookState.view !== 'reader') return;
    clearTimeout(bookResizeTimer);
    bookResizeTimer = setTimeout(() => {
      const a = bookState.article;
      if (!a) return;
      const per = isNarrowBook() ? 1 : 2;
      const startPage = bookState.spread * per;
      bookState.pages = paginateArticle(a);
      bookState.spread = Math.max(0, Math.min(
        Math.floor(startPage / per),
        Math.ceil(bookState.pages.length / per) - 1
      ));
      renderReader();
    }, 220);
  });

  /* ★★★【书架模块】结束★★★ */

  /* ---------------- 入口绑定 ---------------- */
  $('#btn-focus').addEventListener('click', () => { resetDurationUI(); openModal('focus-setup'); });
  $('#btn-bedroom').addEventListener('click', enterBedroom);
  $('#bedroom-back').addEventListener('click', leaveBedroom);
  $('#bedroom-shelf').addEventListener('click', openBook);  /* ★★★【书架入口 · 卧室右上角】事件绑定 → 打开书本弹窗 ★★★ */
  $('#btn-settings').addEventListener('click', () => { syncSettingsUI(); openModal('modal-settings'); });
  $('#btn-feedback').addEventListener('click', () => openModal('modal-feedback'));

  /* ---------------- 登录 / 注册 ---------------- */
  let authMode = 'login';
  function setAuthMode(mode) {
    authMode = mode;
    $('#auth-tab-login').classList.toggle('active', mode === 'login');
    $('#auth-tab-register').classList.toggle('active', mode === 'register');
    $('#auth-pwd2-field').hidden = mode !== 'register';
    $('#auth-submit').textContent = mode === 'login' ? '登录' : '注册并进入';
    $('#auth-err').hidden = true;
  }
  $('#auth-tab-login').addEventListener('click', () => { setAuthMode('login'); sfx.select(); });
  $('#auth-tab-register').addEventListener('click', () => { setAuthMode('register'); sfx.select(); });

  /* ---------------- 个人档案：头像 / 周报 / 断线恢复 ---------------- */
  const AVATARS = [
    { bg: '#16284e', skin: '#a9e4f7', accent: '#7ce8ff' },
    { bg: '#3a1f3a', skin: '#f2c4e0', accent: '#ff9fd0' },
    { bg: '#123a32', skin: '#b9f0d8', accent: '#6fe3b8' },
    { bg: '#3a2a12', skin: '#ffe0a8', accent: '#ffc35c' },
    { bg: '#1e2a4a', skin: '#c9d4ff', accent: '#9db3ff' },
    { bg: '#3a1620', skin: '#ffc9c9', accent: '#ff9191' }
  ];
  function avatarSVG(index, size) {
    const n = AVATARS.length;
    const a = AVATARS[((Number(index) || 0) % n + n) % n];
    return '<svg viewBox="0 0 64 64" width="' + size + '" height="' + size + '" aria-hidden="true" focusable="false">' +
      '<rect width="64" height="64" rx="32" fill="' + a.bg + '"/>' +
      '<circle cx="50" cy="12" r="1.6" fill="#ffffff" opacity=".7"/>' +
      '<circle cx="14" cy="18" r="1.2" fill="#ffffff" opacity=".5"/>' +
      '<circle cx="45" cy="53" r="1.4" fill="' + a.accent + '" opacity=".6"/>' +
      '<ellipse cx="32" cy="35" rx="21" ry="19.5" fill="' + a.skin + '" stroke="#0b1526" stroke-width="2"/>' +
      '<ellipse cx="24.5" cy="34" rx="4.4" ry="5.6" fill="#0b1526"/>' +
      '<ellipse cx="39.5" cy="34" rx="4.4" ry="5.6" fill="#0b1526"/>' +
      '<circle cx="23" cy="32" r="1.5" fill="#ffffff"/>' +
      '<circle cx="38" cy="32" r="1.5" fill="#ffffff"/>' +
      '<path d="M27 43 q5 4.5 10 0" fill="none" stroke="#2f6f8e" stroke-width="2.4" stroke-linecap="round"/>' +
      '<circle cx="17" cy="40" r="2" fill="#f7b9c4" opacity=".5"/>' +
      '<circle cx="47" cy="40" r="2" fill="#f7b9c4" opacity=".5"/>' +
      '</svg>';
  }
  const profileData = () => {
    const p = store.get(KEY.profile, {});
    return (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
  };
  const saveProfile = (patch) => store.set(KEY.profile, Object.assign({}, profileData(), patch));

  /* 只认本机 canvas 生成的 data:image/...;base64；导入的备份也走这里过滤 */
  function customAvatar(p) {
    const v = p && p.custom;
    return (typeof v === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) ? v : '';
  }
  function avatarMarkup(p, size) {
    const custom = customAvatar(p);
    if (custom) return '<img src="' + custom + '" alt="" />';
    return avatarSVG(Number(p && p.avatar) || 0, size);
  }
  function renderAvatar() {
    const p = profileData();
    const top = $('#topbar-avatar');
    if (top) top.innerHTML = avatarMarkup(p, 30);
    const big = $('#profile-avatar');
    if (big) big.innerHTML = avatarMarkup(p, 92);
    const preview = $('#avatar-preview');
    if (preview) preview.innerHTML = '<div class="profile-avatar">' + avatarMarkup(p, 96) + '</div>';
    const row = $('#avatar-row');
    if (row) {
      if (!row.dataset.built) {
        row.innerHTML = AVATARS.map((a, k) =>
          '<button type="button" class="avatar-choice" data-avatar="' + k + '" aria-label="预设头像 ' + (k + 1) + '" aria-pressed="false">' +
          avatarSVG(k, 44) + '</button>').join('');
        row.dataset.built = '1';
      }
      const hasCustom = !!customAvatar(p);
      $$('.avatar-choice', row).forEach((b, k) =>
        b.setAttribute('aria-pressed', String(!hasCustom && (Number(p.avatar) || 0) === k)));
    }
    const reset = $('#avatar-reset-btn');
    if (reset) reset.hidden = !customAvatar(p);
  }

  /* 把任意图片裁成 256×256 的 JPEG data URL，避免原图直接塞进 localStorage */
  function fileToAvatar(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const S = 256;
          const canvas = document.createElement('canvas');
          canvas.width = S;
          canvas.height = S;
          const ctx = canvas.getContext('2d');
          const scale = Math.max(S / img.naturalWidth, S / img.naturalHeight);
          const w = img.naturalWidth * scale;
          const h = img.naturalHeight * scale;
          ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
          URL.revokeObjectURL(url);
          resolve(canvas.toDataURL('image/jpeg', 0.86));
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  const avatarRow = $('#avatar-row');
  if (avatarRow) {
    avatarRow.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-avatar]');
      if (!btn) return;
      saveProfile({ avatar: Number(btn.dataset.avatar), custom: '' });
      renderAvatar();
      sfx.select();
    });
  }
  const avatarBtn = $('#profile-avatar-btn');
  if (avatarBtn) {
    avatarBtn.addEventListener('click', () => {
      renderAvatar();
      openModal('modal-avatar');
    });
  }
  const avatarFile = $('#avatar-file');
  const avatarUpload = $('#avatar-upload-btn');
  if (avatarUpload && avatarFile) {
    avatarUpload.addEventListener('click', () => avatarFile.click());
    avatarFile.addEventListener('change', () => {
      const file = avatarFile.files && avatarFile.files[0];
      avatarFile.value = '';
      if (!file) return;
      if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
      if (file.size > 12 * 1024 * 1024) { toast('图片请控制在 12MB 以内'); return; }
      fileToAvatar(file).then((dataUrl) => {
        saveProfile({ custom: dataUrl });
        renderAvatar();
        sfx.success();
        toast('头像已更新');
      }).catch(() => toast('这张图片读不出来，换一张试试'));
    });
  }
  const avatarReset = $('#avatar-reset-btn');
  if (avatarReset) {
    avatarReset.addEventListener('click', () => {
      saveProfile({ custom: '' });
      renderAvatar();
      toast('已恢复预设头像');
    });
  }

  function ymd(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  const WEEK_CHARS = ['日', '一', '二', '三', '四', '五', '六'];
  function weekDays() {
    const out = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = ymd(d);
      out.push({
        key: key,
        label: i === 0 ? '今天' : '周' + WEEK_CHARS[d.getDay()],
        value: Number((state.daily && state.daily[key]) || 0),
        today: i === 0
      });
    }
    return out;
  }
  function streakDays() {
    const has = k => Number((state.daily && state.daily[k]) || 0) > 0;
    const d = new Date();
    if (!has(ymd(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (has(ymd(d)) && n < 3650) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function chartSVG(days) {
    const CW = 520, CH = 170, base = 126, maxH = 92, pad = 10, bw = 46;
    const gap = (CW - pad * 2 - bw * 7) / 6;
    const max = Math.max(30, ...days.map(d => d.value));
    let out = '<line x1="' + pad + '" y1="' + (base + 1) + '" x2="' + (CW - pad) + '" y2="' + (base + 1) +
      '" stroke="rgba(130,200,255,.25)" stroke-width="1"/>';
    days.forEach((d, i) => {
      const x = pad + i * (bw + gap);
      const h = d.value > 0 ? Math.max(6, Math.round(d.value / max * maxH)) : 3;
      const y = base - h;
      const fill = d.today ? '#ffd98a' : '#7ce8ff';
      out += '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + h + '" rx="6" fill="' + fill +
        '" opacity="' + (d.value ? 0.92 : 0.22) + '"><title>' + d.label + '：' + d.value + ' 分钟</title></rect>';
      if (d.value) out += '<text x="' + (x + bw / 2) + '" y="' + (y - 8) + '" text-anchor="middle" font-size="12" fill="#93a6c8">' + d.value + '</text>';
      out += '<text x="' + (x + bw / 2) + '" y="' + (base + 24) + '" text-anchor="middle" font-size="12" fill="' +
        (d.today ? '#ffd98a' : '#93a6c8') + '">' + d.label + '</text>';
    });
    return '<svg viewBox="0 0 ' + CW + ' ' + CH + '" width="100%" height="150" role="img" aria-label="近一周每天专注分钟数">' + out + '</svg>';
  }
  function fmtDuration(mins) {
    const m = Number(mins) || 0;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h > 0 ? (h + ' 小时 ' + (r ? r + ' 分' : '')).trim() : (m + ' 分钟');
  }

  /* ---------------- 专注明细 ---------------- */
  const pad2 = (n) => String(n).padStart(2, '0');
  function logTime(ts) {
    const d = new Date(ts);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function dateKeyOf(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function pushHistory(rec) {
    if (!Array.isArray(state.history)) state.history = [];
    state.history.push(rec);
    if (state.history.length > 200) state.history = state.history.slice(-200);
    saveState();
  }
  const HISTORY_LABEL = { done: '完成', manual: '补录', abort: '主动放弃', caught: '被发现', away: '离开超时', strict: '严格模式' };
  function renderHistory() {
    const box = $('#profile-log-list');
    if (!box) return;
    const all = Array.isArray(state.history) ? state.history : [];
    const list = all.slice().sort((a, b) => b.at - a.at).slice(0, 8);
    const sum = $('#profile-log-sum');
    if (sum) sum.textContent = all.length ? ('共 ' + all.length + ' 条') : '';
    if (!list.length) {
      box.innerHTML = '<p class="profile-log__empty">还没有记录，完成一次躲藏后会出现在这里。</p>';
      return;
    }
    box.innerHTML = list.map(r => {
      const label = HISTORY_LABEL[r.reason] || (r.ok ? '完成' : '中断');
      return '<div class="log-item">' +
        '<span class="log-item__time">' + logTime(r.at) + '</span>' +
        '<span class="log-item__mins">' + (r.mins ? r.mins + ' 分钟' : '未计入') + '</span>' +
        '<span class="log-item__tag ' + (r.ok ? 'is-ok' : 'is-bad') + '">' +
          (r.rounds > 1 ? label + ' · ' + r.rounds + ' 轮' : label) + '</span>' +
        '<button class="log-item__del" type="button" data-at="' + r.at + '" aria-label="删除这条记录">×</button>' +
      '</div>';
    }).join('');
  }
  function deleteHistory(at) {
    const idx = (state.history || []).findIndex(r => r.at === at);
    if (idx < 0) return;
    const rec = state.history[idx];
    if (rec.mins) {
      state.totalMinutes = Math.max(0, (state.totalMinutes || 0) - rec.mins);
      const d = dateKeyOf(rec.at);
      if (state.daily && state.daily[d]) state.daily[d] = Math.max(0, state.daily[d] - rec.mins);
    }
    if (rec.ok) {
      const rounds = rec.rounds || 1;
      state.success = Math.max(0, (state.success || 0) - rounds);
      state.sessions = Math.max(0, (state.sessions || 0) - rounds);
    } else {
      state.failed = Math.max(0, (state.failed || 0) - 1);
      state.interruptions = Math.max(0, (state.interruptions || 0) - 1);
      /* 连续模式中途失败时，已完成的轮次也计过成功 */
      if (rec.mins > 0) {
        const rounds = rec.rounds || 1;
        state.success = Math.max(0, (state.success || 0) - rounds);
        state.sessions = Math.max(0, (state.sessions || 0) - rounds);
      }
    }
    state.history.splice(idx, 1);
    saveState();
    renderStats();
    renderProfile();
    toast('已删除这条记录');
  }
  function addManualSession(raw) {
    const m = Math.round(Number(raw));
    if (!m || m < 1 || m > 600) { toast('请输入 1–600 分钟'); return; }
    const t = today();
    state.totalMinutes = (state.totalMinutes || 0) + m;
    if (!state.daily) state.daily = {};
    state.daily[t] = (state.daily[t] || 0) + m;
    if (state.days.indexOf(t) === -1) state.days.push(t);
    state.success = (state.success || 0) + 1;
    state.sessions = (state.sessions || 0) + 1;
    state.longestMinutes = Math.max(state.longestMinutes || 0, m);
    pushHistory({ at: Date.now(), mins: m, ok: true, rounds: 1, reason: 'manual' });
    saveState();
    renderStats();
    renderProfile();
    const input = $('#profile-log-min');
    if (input) input.value = '';
    toast('已补录 ' + m + ' 分钟');
  }
  function renderProfile() {
    const name = accountName || '游客';
    $('#profile-title').textContent = name;
    $('#profile-sub').textContent = accountName
      ? '记录只保存在这台设备的浏览器里'
      : '登录后记录会独立保存，并可导出备份';
    const breaks = Number((state.interruptions != null ? state.interruptions : state.failed) || 0);
    $('#profile-stats').innerHTML =
      '<div><strong>' + fmtDuration(state.totalMinutes) + '</strong><small>专注时长</small></div>' +
      '<div title="主动放弃、被发现或离开超时的次数"><strong>' + breaks + ' 次</strong><small>断开次数</small></div>' +
      '<div><strong>' + streakDays() + ' 天</strong><small>连续躲藏</small></div>';
    const days = weekDays();
    const total = days.reduce((a, b) => a + b.value, 0);
    $('#profile-week-sum').textContent = total
      ? ('合计 ' + total + ' 分钟 · 日均 ' + Math.round(total / 7) + ' 分')
      : '还没有记录';
    $('#profile-chart').innerHTML = chartSVG(days);
    renderHistory();
    $('#profile-auth').hidden = !!accountName;
    $('#profile-logout').hidden = !accountName;
    renderAvatar();
  }
  function openProfile() {
    renderProfile();
    openModal('modal-profile');
  }
  function openAuth(mode) {
    setAuthMode(mode || 'login');
    $('#auth-name').value = '';
    $('#auth-pwd').value = '';
    $('#auth-pwd2').value = '';
    $('#auth-err').hidden = true;
    openModal('modal-auth');
    setTimeout(() => $('#auth-name').focus(), 320);
  }

  $('#btn-account').addEventListener('click', openProfile);
  $('#profile-auth').addEventListener('click', () => {
    closeModal('modal-profile');
    setTimeout(() => openAuth('login'), 260);
  });
  $('#profile-logout').addEventListener('click', () => {
    accountLogout();
    closeModal('modal-profile');
    sfx.select();
    toast('已退出登录，回到游客身份');
  });
  const profileLogList = $('#profile-log-list');
  if (profileLogList) {
    profileLogList.addEventListener('click', (e) => {
      const btn = e.target.closest('.log-item__del');
      if (btn) deleteHistory(Number(btn.dataset.at));
    });
  }
  const profileLogAdd = $('#profile-log-add');
  if (profileLogAdd) {
    profileLogAdd.addEventListener('click', () => addManualSession($('#profile-log-min').value));
    $('#profile-log-min').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addManualSession($('#profile-log-min').value); }
    });
  }

  /* ---------------- 断线恢复 ---------------- */
  let pendingLive = null;
  let liveChecked = false;
  function checkLiveSession() {
    if (liveChecked) return;
    liveChecked = true;
    const live = store.get(KEY.live, null);
    if (!live) return;
    if (live.phase !== 'focus') { store.remove(KEY.live); return; }
    const remain = live.endAt - Date.now();
    /* 超时 2 分钟以上不再允许「一键补回整段时长」 */
    if (remain <= -2 * 60000) {
      store.remove(KEY.live);
      setTimeout(() => toast('上次的躲藏已经超时，没有计入'), 1200);
      return;
    }
    pendingLive = live;
    $('#resume-text').innerHTML =
      (remain > 0 ? '还剩 <strong>' + fmtTime(remain) + '</strong>。' : '计时已经走完。') +
      '<br/>要接着把这轮躲完吗？';
    openModal('modal-resume');
  }
  $('#resume-continue').addEventListener('click', () => {
    closeModal('modal-resume');
    const live = pendingLive;
    pendingLive = null;
    if (live) resumeLiveSession(live);
  });
  $('#resume-discard').addEventListener('click', () => {
    store.remove(KEY.live);
    pendingLive = null;
    closeModal('modal-resume');
    toast('已经放弃这次躲藏');
  });
  function resumeLiveSession(live) {
    if (live.endAt - Date.now() <= -2 * 60000) {
      clearLive();
      toast('这次躲藏已经超时，没有计入');
      return;
    }
    focus.phase = 'focus';
    focus.running = true;
    focus.continuous = !!live.continuous;
    focus.focusMin = live.focusMin || live.minutes;
    focus.breakMs = live.breakMs || 10 * 60000;
    focus.round = live.round || 1;
    focus.totalRounds = live.totalRounds ? live.totalRounds : Infinity;
    focus.minutes = live.minutes;
    focus.totalMs = live.totalMs || live.minutes * 60000;
    focus.endAt = live.endAt;
    focus.cycleMinutes = live.cycleMinutes || 0;
    focus.risk = 0;
    focus.hiddenAt = 0;
    focus.awayTotal = live.awayTotal || 0;
    focus.sessionStart = live.sessionStart || Date.now();
    focus.statusIdx = 0;
    paintFocusRun();
    document.title = '🛸 专注中 ' + fmtTime(Math.max(0, focus.endAt - Date.now())) + ' · behuman';
    startFocusTimers();
    startBgm();
    saveLive();
    toast('接着躲，别出声');
  }

  $('#auth-submit').addEventListener('click', async () => {
    const name = $('#auth-name').value.trim();
    const pwd = $('#auth-pwd').value;
    const pwd2 = $('#auth-pwd2').value;
    const errEl = $('#auth-err');
    const showErr = (m) => { errEl.textContent = m; errEl.hidden = false; };
    if (!/^[一-龥A-Za-z0-9_]{2,12}$/.test(name)) { showErr('身份代号需为 2–12 位中英文、数字或下划线'); return; }
    if (pwd.length < 6) { showErr('密码至少 6 位'); return; }
    if (authMode === 'register' && pwd2 !== pwd) { showErr('两次输入的密码不一致'); return; }
    const btn = $('#auth-submit');
    btn.disabled = true;
    btn.textContent = '正在验证…';
    const res = authMode === 'login' ? await accountLogin(name, pwd) : await accountRegister(name, pwd);
    btn.disabled = false;
    if (res.ok) {
      closeModal('modal-auth');
      sfx.success();
      toast(authMode === 'login' ? ('欢迎回到地球，' + name) : ('注册成功，已以「' + name + '」的身份进入'));
    } else {
      btn.textContent = authMode === 'login' ? '登录' : '注册并进入';
      showErr(res.msg);
    }
  });

  /* ---------------- 启动 ---------------- */
  buildStars();
  syncSettingsUI();
  renderAccountUI();
  initDurationUI();

  if (store.get(KEY.intro, {}).watched) {
    $('#intro').hidden = true;
    showApp();
    if (location.hash === '#profile') setTimeout(openProfile, 900);
  } else {
    $('#app').hidden = true;
    intro.play();
  }
})();
