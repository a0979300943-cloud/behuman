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
    slots: 'bh.slots',
    settings: 'bh.settings',
    intro: 'bh.intro',
    feedback: 'bh.feedback'
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
    longestMinutes: 0,
    days: []
  });

  let state = Object.assign(freshState(), store.get(KEY.state, {}));
  let settings = Object.assign({ defaultMin: 25, sound: true }, store.get(KEY.settings, {}));
  let slots = store.get(KEY.slots, { 1: null, 2: null, 3: null });

  const saveState = () => store.set(KEY.state, state);
  const saveSettings = () => store.set(KEY.settings, settings);
  const saveSlots = () => store.set(KEY.slots, slots);

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

  /* 注册时把游客的文本数据复制到新账号空间（无缝继承本机旧记录） */
  function copyGuestDataToAccount(user) {
    Object.keys(KEY).forEach(k => {
      try {
        const raw = localStorage.getItem(KEY[k]);
        if (raw != null) localStorage.setItem('bh.u.' + user + '.' + k, raw);
      } catch (e) {}
    });
  }

  /* 切换身份后重新载入内存数据并刷新界面 */
  function afterAccountChanged() {
    state = Object.assign(freshState(), store.get(KEY.state, {}));
    settings = Object.assign({ defaultMin: 25, sound: true }, store.get(KEY.settings, {}));
    slots = store.get(KEY.slots, { 1: null, 2: null, 3: null });
    renderStats();
    if (typeof syncSettingsUI === 'function') syncSettingsUI();
    renderAccountUI();
  }
  function renderAccountUI() {
    $('#account-label').textContent = accountName || '登录/注册';
    $('#account-menu-name').textContent = accountName ? ('当前身份：' + accountName) : '';
    $('#btn-logout').hidden = !accountName;
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
    fail() { [392, 311, 262].forEach((f, i) => tone(f, 0.4, 'sawtooth', 0.045, i * 0.22)); }
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

  /* ---------------- 弹窗通用 ---------------- */
  function openModal(id) {
    const m = $('#' + id);
    m.hidden = false;
    requestAnimationFrame(() => m.classList.add('show'));
    // 兜底：页面在后台标签等情况下 rAF 可能不触发，确保弹窗最终显示
    setTimeout(() => m.classList.add('show'), 60);
    sfx.select();
  }
  function closeModal(m) {
    if (typeof m === 'string') m = $('#' + m);
    if (!m || m.hidden) return;
    m.classList.remove('show');
    setTimeout(() => { m.hidden = true; }, 250);
  }
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) { closeModal(closeBtn.closest('.modal-mask')); return; }
    const mask = e.target.closest('.modal-mask');
    if (mask && e.target === mask) closeModal(mask);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal-mask.show').forEach(closeModal);
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
    bgmMode: ''
  };

  /* B站背景音乐：专注开始后注入隐藏 iframe，只听声音不显示画面 */
  function biliBgmInject() {
    const parsed = parseBiliId(settings.biliBgm);
    if (!parsed) return;
    const box = $('#focus-bili');
    box.innerHTML = '';
    const f = document.createElement('iframe');
    f.src = 'https://player.bilibili.com/player.html?' +
      (parsed.t === 'bv' ? 'bvid=' + parsed.id : 'aid=' + parsed.id) +
      '&autoplay=1&mute=0&danmaku=0';
    f.setAttribute('frameborder', '0');
    f.setAttribute('scrolling', 'no');
    f.setAttribute('allow', 'autoplay; encrypted-media');
    box.appendChild(f);
    focus.bgmMode = 'bili';
  }

  function startBgm() {
    if (parseBiliId(settings.biliBgm)) {
      biliBgmInject();
      $('#focus-bgm').textContent = '🎵';
      $('#focus-bgm').hidden = false;
      return;
    }
    media.get('audio').then(rec => {
      if (focus.phase !== 'focus' || !rec || !rec.blob) return;
      const a = $('#focus-audio');
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
    focus.bgmMode = '';
    $('#focus-bgm').hidden = true;
    if (focus.bgmURL) { URL.revokeObjectURL(focus.bgmURL); focus.bgmURL = null; }
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
    focus.statusIdx = 0;

    const run = $('#focus-running');
    run.hidden = false;
    run.classList.remove('is-break');
    requestAnimationFrame(() => run.classList.add('show'));

    $('#focus-status').hidden = false;
    $('#focus-status').textContent = focus.statuses[0];
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
    sfx.alarm();
    document.title = '🛸 专注中 ' + fmtTime(focus.totalMs) + ' · behuman';

    clearInterval(focus.timer);
    focus.timer = setInterval(tick, 250);
    clearInterval(focus.statusTimer);
    focus.statusTimer = setInterval(() => {
      focus.statusIdx = (focus.statusIdx + 1) % focus.statuses.length;
      $('#focus-status').textContent = focus.statuses[focus.statusIdx];
    }, 22000);

    startBgm();
  }

  function beginBreak() {
    focus.phase = 'break';
    focus.totalMs = focus.breakMs;
    focus.endAt = Date.now() + focus.breakMs;
    $('#focus-warning').hidden = true;

    const run = $('#focus-running');
    run.classList.add('is-break');
    $('#focus-status').textContent = '伪装暂时稳定 · 休息时间';
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
  }

  function tick() {
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
    state.totalMinutes += min;
    state.success = (state.success || 0) + 1;
    state.longestMinutes = Math.max(state.longestMinutes || 0, min);
    focus.cycleMinutes += min;
    saveState();
    renderStats();
    sfx.success();

    clearInterval(focus.statusTimer);
    stopBgm();
    if (focus.continuous) {
      // 已完成设定轮数：直接结算，不再进入休息
      if (focus.round >= focus.totalRounds) { endFocus(true); return; }
      beginBreak();
    } else {
      endFocus(true);
    }
  }

  function endFocus(success, aborted) {
    if (!focus.running) return;
    const wasContinuous = focus.continuous;
    const cycleRounds = focus.round;
    const cycleMins = focus.cycleMinutes;
    focus.running = false;
    focus.phase = 'idle';
    clearInterval(focus.timer);
    clearInterval(focus.statusTimer);
    stopBgm();
    document.title = 'behuman · 成为人类吧！';

    const run = $('#focus-running');
    run.classList.remove('show', 'is-break');
    setTimeout(() => { run.hidden = true; }, 300);

    if (!success) {
      state.failed = (state.failed || 0) + 1;
      saveState();
      sfx.fail();
    }
    renderStats();
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
    if (!focus.running || focus.phase !== 'focus') return;
    if (document.hidden) {
      focus.hiddenAt = Date.now();
    } else if (focus.hiddenAt) {
      const awaySec = Math.round((Date.now() - focus.hiddenAt) / 1000);
      focus.hiddenAt = 0;
      if (awaySec >= 15) {
        focus.risk += 1;
        renderRisk();
        $('#focus-warning-text').innerHTML =
          '你离开页面 <strong>' + awaySec + '</strong> 秒，巷口的人类差点发现你！<br/>第 ' + focus.risk + ' 次暴露风险（累计 3 次任务失败）。';
        $('#focus-warning').hidden = false;
        sfx.alarm();
        // 风险期间暂停计时
        focus.endAt += awaySec * 1000;
        if (focus.risk >= 3) {
          $('#focus-warning').hidden = true;
          endFocus(false, false);
        }
      }
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
        $('#focus-bgm').textContent = '🔇';
      } else {
        biliBgmInject();
        $('#focus-bgm').textContent = '🎵';
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

  /* ---------------- 存档 / 读档 ---------------- */
  function slotSummary(s) {
    if (!s) return '';
    return '居留 ' + (s.state.totalMinutes || 0) + ' 分钟 · 成功 ' + (s.state.success || 0) +
      ' 次 · 最长 ' + (s.state.longestMinutes || 0) + ' 分钟';
  }

  function renderSaveSlots() {
    const box = $('#save-slots');
    box.innerHTML = '';
    [1, 2, 3].forEach(i => {
      const s = slots[i];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'slot' + (s ? '' : ' slot--empty');
      card.innerHTML =
        '<span class="slot__no">舱位 ' + i + '</span>' +
        (s
          ? '<span class="slot__info">' + slotSummary(s) + '</span><span class="slot__time">' + fmtDate(s.savedAt) + '</span><span class="slot__action">覆盖保存</span>'
          : '<span class="slot__info">空舱位</span><span class="slot__time">——</span><span class="slot__action">写入记录</span>');
      card.addEventListener('click', () => {
        if (s && !confirm('覆盖舱位 ' + i + ' 中原有的记录？')) return;
        slots[i] = { savedAt: new Date().toISOString(), state: JSON.parse(JSON.stringify(state)) };
        saveSlots();
        renderSaveSlots();
        toast('已保存到 ' + i + ' 号星轨舱');
        sfx.success();
      });
      box.appendChild(card);
    });
  }

  function renderLoadSlots() {
    const box = $('#load-slots');
    box.innerHTML = '';
    [1, 2, 3].forEach(i => {
      const s = slots[i];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'slot' + (s ? '' : ' slot--empty slot--disabled');
      card.disabled = !s;
      card.innerHTML =
        '<span class="slot__no">舱位 ' + i + '</span>' +
        (s
          ? '<span class="slot__info">' + slotSummary(s) + '</span><span class="slot__time">' + fmtDate(s.savedAt) + '</span><span class="slot__action">读取记录</span>'
          : '<span class="slot__info">空舱位</span><span class="slot__time">——</span><span class="slot__action">暂无记录</span>');
      if (s) card.addEventListener('click', () => {
        if (!confirm('读取舱位 ' + i + ' 的记录？当前未保存的进度将被替换。')) return;
        state = Object.assign(freshState(), JSON.parse(JSON.stringify(s.state)));
        saveState();
        renderStats();
        closeModal('modal-load');
        toast('已取回 ' + i + ' 号星轨舱的记忆');
        sfx.success();
      });
      box.appendChild(card);
    });
  }

  /* ---------------- 设置 ---------------- */
  function syncSettingsUI() {
    $('#set-default-min').value = String(settings.defaultMin);
    $('#set-sound').checked = !!settings.sound;
    $('#set-bili-bgm').value = settings.biliBgm || '';
    $('#set-bili-bgm-clear').hidden = !settings.biliBgm;
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

  /* ---------------- B站背景音乐设置 ---------------- */
  $('#set-bili-bgm-save').addEventListener('click', () => {
    const raw = $('#set-bili-bgm').value.trim();
    if (!parseBiliId(raw)) { toast('没识别出 BV 号或 av 号，请检查链接'); return; }
    settings.biliBgm = raw;
    saveSettings();
    $('#set-bili-bgm-clear').hidden = false;
    sfx.select();
    toast('已保存，专注时将后台播放该视频声音');
  });
  $('#set-bili-bgm-clear').addEventListener('click', () => {
    settings.biliBgm = '';
    saveSettings();
    $('#set-bili-bgm').value = '';
    $('#set-bili-bgm-clear').hidden = true;
    sfx.select();
    toast('已移除，恢复本地音频或静音');
  });
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
    if (!confirm('将清空' + who + '全部专注记录、三个舱位存档与设置，且无法恢复。确定吗？')) return;
    if (!confirm('真的要让外星人忘记在地球上的一切吗？')) return;
    Object.keys(KEY).forEach(k => store.remove(KEY[k]));
    media.clear();
    state = freshState();
    settings = { defaultMin: 25, sound: true };
    slots = { 1: null, 2: null, 3: null };
    renderStats();
    syncSettingsUI();
    closeModal('modal-settings');
    toast('所有数据已清空（含导入的音频与视频）');
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

  /* ---------------- 入口绑定 ---------------- */
  $('#btn-focus').addEventListener('click', () => { resetDurationUI(); openModal('focus-setup'); });
  $('#btn-save').addEventListener('click', () => { renderSaveSlots(); openModal('modal-save'); });
  $('#btn-load').addEventListener('click', () => { renderLoadSlots(); openModal('modal-load'); });
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

  $('#btn-account').addEventListener('click', (e) => {
    e.stopPropagation();
    if (accountName) {
      $('#account-menu').hidden = !$('#account-menu').hidden;
    } else {
      setAuthMode('login');
      $('#auth-name').value = '';
      $('#auth-pwd').value = '';
      $('#auth-pwd2').value = '';
      $('#auth-err').hidden = true;
      openModal('modal-auth');
      setTimeout(() => $('#auth-name').focus(), 300);
    }
  });
  document.addEventListener('click', (e) => {
    const menu = $('#account-menu');
    if (!menu.hidden && !e.target.closest('#account-menu') && !e.target.closest('#btn-account')) {
      menu.hidden = true;
    }
  });
  $('#btn-logout').addEventListener('click', () => {
    accountLogout();
    $('#account-menu').hidden = true;
    sfx.select();
    toast('已退出登录，回到游客身份');
  });

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
  } else {
    $('#app').hidden = true;
    intro.play();
  }
})();
