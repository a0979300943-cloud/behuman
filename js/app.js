/* ============================================================
 * behuman · 成为人类吧！
 * 剧情化专注自习网站主逻辑
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 工具 ---------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

  const store = {
    get(k, d) {
      try {
        const raw = localStorage.getItem(k);
        return raw == null ? d : JSON.parse(raw);
      } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
    },
    remove(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  const KEY = {
    state: 'bh.state',
    slots: 'bh.slots',
    settings: 'bh.settings',
    intro: 'bh.intro',
    feedback: 'bh.feedback'
  };

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
    timers: [],
    started: false,
    total: 0,
    startTime: 0,
    progressTimer: null,

    lineMs(text) { return Math.min(7000, 2600 + text.length * 210); },

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

      await Promise.race([
        this.preload(),
        new Promise(r => setTimeout(r, 9000))
      ]);
      this.el.classList.remove('is-loading');

      // 总时长（含每场 0.9s 转场）
      this.total = window.STORY.reduce((sum, s) =>
        sum + s.lines.reduce((a, l) => a + this.lineMs(l), 0) + 900, 0);

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
        }, 450);
        this.runLine(si, 0);
      };
      this.timers.push(setTimeout(show, accDelay));
    },

    runLine(si, li) {
      const scene = window.STORY[si];
      if (li >= scene.lines.length) {
        // 下一场
        this.timers.push(setTimeout(() => this.runScene(si + 1, 0), this.lineMs(scene.lines[scene.lines.length - 1]) + 500));
        return;
      }
      const line = scene.lines[li];
      this.text.classList.remove('caption-in');
      void this.text.offsetWidth;
      this.text.textContent = line;
      this.text.classList.add('caption-in');
      this.timers.push(setTimeout(() => this.runLine(si, li + 1), this.lineMs(line)));
    },

    finish() {
      clearInterval(this.progressTimer);
      this.timers.forEach(clearTimeout);
      this.timers = [];
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

  /* ---------------- 开始专注 ---------------- */
  const focus = {
    running: false,
    totalMs: 0,
    endAt: 0,
    risk: 0,
    timer: null,
    hiddenAt: 0,
    minutes: 0,
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
    statusIdx: 0
  };

  function initDurationUI() {
    const btns = $$('#duration-options button');
    const custom = $('#custom-min');
    btns.forEach(b => b.addEventListener('click', () => {
      btns.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      custom.value = '';
      sfx.select();
    }));
    custom.addEventListener('input', () => {
      if (custom.value) btns.forEach(x => x.classList.remove('active'));
    });
  }
  function resetDurationUI() {
    $$('#duration-options button').forEach(b =>
      b.classList.toggle('active', Number(b.dataset.min) === Number(settings.defaultMin)));
    $('#custom-min').value = '';
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

  function startFocus() {
    const min = chosenMinutes();
    if (!min) { toast('请输入 1–180 之间的分钟数'); return; }

    closeModal('focus-setup');
    focus.running = true;
    focus.minutes = min;
    focus.totalMs = min * 60000;
    focus.endAt = Date.now() + focus.totalMs;
    focus.risk = 0;
    focus.hiddenAt = 0;
    focus.statusIdx = 0;

    $('#focus-running').hidden = false;
    requestAnimationFrame(() => $('#focus-running').classList.add('show'));
    $('#focus-timer').textContent = fmtTime(focus.totalMs);
    $('#focus-percent').textContent = '100%';
    $('#focus-bar').style.width = '100%';
    $('#focus-status').textContent = focus.statuses[0];
    renderRisk();
    sfx.alarm();
    document.title = '🛸 专注中 ' + fmtTime(focus.totalMs) + ' · behuman';

    clearInterval(focus.timer);
    focus.timer = setInterval(tick, 250);
    focus.statusTimer = setInterval(() => {
      focus.statusIdx = (focus.statusIdx + 1) % focus.statuses.length;
      $('#focus-status').textContent = focus.statuses[focus.statusIdx];
    }, 22000);
  }

  function tick() {
    const remain = focus.endAt - Date.now();
    $('#focus-timer').textContent = fmtTime(remain);
    const pct = Math.max(0, remain / focus.totalMs);
    $('#focus-bar').style.width = (pct * 100).toFixed(1) + '%';
    $('#focus-percent').textContent = Math.round(pct * 100) + '%';
    document.title = '🛸 专注中 ' + fmtTime(remain) + ' · behuman';
    if (remain <= 0) endFocus(true);
  }

  function renderRisk() {
    $$('#focus-risk i').forEach((dot, i) => dot.classList.toggle('on', i < focus.risk));
  }

  function endFocus(success, aborted) {
    if (!focus.running) return;
    focus.running = false;
    clearInterval(focus.timer);
    clearInterval(focus.statusTimer);
    document.title = 'behuman · 成为人类吧！';

    const run = $('#focus-running');
    run.classList.remove('show');
    setTimeout(() => { run.hidden = true; }, 300);

    state.sessions = (state.sessions || 0) + 1;
    const t = today();
    if (state.days.indexOf(t) === -1) state.days.push(t);

    if (success) {
      const min = focus.minutes;
      state.totalMinutes += min;
      state.success = (state.success || 0) + 1;
      state.longestMinutes = Math.max(state.longestMinutes || 0, min);
      saveState();
      sfx.success();
      showResult(true, min);
    } else {
      state.failed = (state.failed || 0) + 1;
      saveState();
      sfx.fail();
      showResult(false, 0, aborted);
    }
    renderStats();
  }

  function showResult(ok, minutes, aborted) {
    const title = $('#result-title');
    const emoji = $('#result-emoji');
    const text = $('#result-text');
    const grid = $('#result-grid');

    if (ok) {
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
    } else {
      title.textContent = aborted ? '你选择了现形' : '被发现了！';
      emoji.textContent = aborted ? '🌫️' : '👁️';
      text.textContent = aborted
        ? '你提前离开了躲藏点，伪装在人群面前消散……这次不会计入居留时长，下一次藏久一点。'
        : '你离开页面的时间太久，被路过的人类看到了原型！本次专注失败，深呼吸，再来一次。';
      grid.innerHTML =
        '<div><strong>0 分钟</strong><small>本次居留</small></div>' +
        '<div><strong>' + (state.failed || 0) + ' 次</strong><small>暴露次数</small></div>' +
        '<div><strong>' + (state.success || 0) + ' 次</strong><small>成功次数</small></div>';
    }
    openModal('focus-result');
  }

  document.addEventListener('visibilitychange', () => {
    if (!focus.running) return;
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
    if (confirm('提前现形意味着本次专注失败，且不计入居留时长。确定放弃吗？')) {
      endFocus(false, true);
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
  }
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
    if (!confirm('将清空全部专注记录、三个舱位存档与设置，且无法恢复。确定吗？')) return;
    if (!confirm('真的要让外星人忘记在地球上的一切吗？')) return;
    Object.keys(KEY).forEach(k => store.remove(KEY[k]));
    state = freshState();
    settings = { defaultMin: 25, sound: true };
    slots = { 1: null, 2: null, 3: null };
    renderStats();
    syncSettingsUI();
    closeModal('modal-settings');
    toast('所有数据已清空');
  });

  /* ---------------- 意见反馈 ---------------- */
  const fbContent = $('#fb-content');
  fbContent.addEventListener('input', () => { $('#fb-count').textContent = fbContent.value.length; });
  $('#feedback-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const content = fbContent.value.trim();
    if (!content) { toast('请先写下反馈内容'); return; }
    const list = store.get(KEY.feedback, []);
    list.push({ content: content, contact: $('#fb-contact').value.trim(), at: new Date().toISOString() });
    store.set(KEY.feedback, list);
    $('#fb-ok').hidden = false;
    sfx.success();
    setTimeout(() => {
      $('#fb-ok').hidden = true;
      e.target.reset();
      $('#fb-count').textContent = '0';
      closeModal('modal-feedback');
    }, 1600);
  });

  /* ---------------- 入口绑定 ---------------- */
  $('#btn-focus').addEventListener('click', () => { resetDurationUI(); openModal('focus-setup'); });
  $('#btn-save').addEventListener('click', () => { renderSaveSlots(); openModal('modal-save'); });
  $('#btn-load').addEventListener('click', () => { renderLoadSlots(); openModal('modal-load'); });
  $('#btn-settings').addEventListener('click', () => { syncSettingsUI(); openModal('modal-settings'); });
  $('#btn-feedback').addEventListener('click', () => openModal('modal-feedback'));

  /* ---------------- 启动 ---------------- */
  buildStars();
  syncSettingsUI();
  initDurationUI();

  if (store.get(KEY.intro, {}).watched) {
    $('#intro').hidden = true;
    showApp();
  } else {
    $('#app').hidden = true;
    intro.play();
  }
})();
