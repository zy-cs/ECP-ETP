// ==UserScript==
// @name         评标系统 · 会话保活 v3（可见状态 + 自动取证）
// @namespace    local.keepalive
// @version      3.0
// @description  每 2 分钟只读心跳续期；页面可见状态条 + 把诊断镜像到站点 localStorage；不刷新页面、不拦截登出、不改 token
// @match        http://1.189.64.203:29999/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      1.189.64.203
// ==/UserScript==

(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  const API = '/tdServer/getInfo';
  const TOKEN_KEY = 'Admin-Token';
  const SALT = 'lyp82nlf';
  const DIAG_KEY = '__ka_diag';   // 镜像到站点 localStorage，便于从本机直接取证
  const K_LOG = 'ka_v3_logs';
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const LS = W.localStorage;

  let enabled = true, minutes = 2;
  try { enabled = GM_getValue('enabled', true); minutes = GM_getValue('minutes', 2); } catch (e) { /* 忽略 */ }
  let timer = null, watchTimer = null;
  let hadToken = !!LS.getItem(TOKEN_KEY);

  const state = {
    v: 3, bootAt: Date.now(), t: 0, status: 'init',
    http: null, code: null, ms: 0, channel: '', token: '',
    lastBeat: 0, lastOk: 0, okCount: 0, failCount: 0,
    lastErr: '', reason: '', type: '', gap: '',
    url: location.href.slice(0, 120), logs: []
  };

  const fp = t => t ? t.slice(0, 6) + '…' + t.slice(-4) : '(none)';
  const hhmmss = ts => ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—';

  /* ---------- 诊断持久化：GM 值 + 站点 localStorage 双写 ---------- */
  function save() {
    state.t = Date.now();
    try { LS.setItem(DIAG_KEY, JSON.stringify(state)); } catch (e) { /* 忽略 */ }
    render();
  }

  function log(kind, msg) {
    const now = Date.now();
    state.logs.push({ t: now, kind: kind, msg: msg });
    if (state.logs.length > 14) state.logs = state.logs.slice(-14);
    try {
      const arr = GM_getValue(K_LOG, []);
      arr.push({ t: now, kind: kind, msg: msg });
      GM_setValue(K_LOG, arr.slice(-40));
    } catch (e) { /* GM 值失败不能影响心跳 */ }
    save();
  }

  /* ---------- MD5（输入为 encodeURIComponent 后的纯 ASCII） ---------- */
  const SHIFTS = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];
  const K = Array.from({ length: 64 }, (_, i) =>
    Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0
  );

  function md5(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff);
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 0; i < 8; i++) bytes.push(i < 4 ? ((bitLen >>> (8 * i)) & 0xff) : 0);

    let a0 = 1732584193, b0 = -271733879, c0 = -1732584194, d0 = 271733878;
    const X = new Array(16);
    for (let off = 0; off < bytes.length; off += 64) {
      for (let j = 0; j < 16; j++) {
        const p = off + j * 4;
        X[j] = (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) | 0;
      }
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * i) % 16; }
        const sum = (a + f + K[i] + X[g]) | 0;
        const s = SHIFTS[i];
        const rot = ((sum << s) | (sum >>> (32 - s))) | 0;
        const tmp = d;
        d = c; c = b; b = (b + rot) | 0; a = tmp;
      }
      a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
    }
    return [a0, b0, c0, d0].map(n =>
      [0, 8, 16, 24].map(sh => ('0' + ((n >>> sh) & 0xff).toString(16)).slice(-2)).join('')
    ).join('');
  }

  function makeSign(token, time) {
    const raw = encodeURIComponent('{"signParamTzkj":""}' + token + time + SALT).toLocaleLowerCase();
    return md5(raw);
  }

  function nonce() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < 16; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
  }

  /* ---------- 双通道请求 ---------- */
  function gmFetch(url, headers) {
    return new Promise(res => {
      if (typeof GM_xmlhttpRequest === 'undefined') { res({ status: 0, text: 'GM_xmlhttpRequest 不可用' }); return; }
      try {
        GM_xmlhttpRequest({
          method: 'GET', url: location.origin + url, headers: headers, timeout: 15000,
          onload: r => res({ status: r.status, text: r.responseText }),
          onerror: () => res({ status: 0, text: '网络错误' }),
          ontimeout: () => res({ status: -1, text: '超时' })
        });
      } catch (e) { res({ status: 0, text: e.message }); }
    });
  }

  async function heartbeat() {
    const token = LS.getItem(TOKEN_KEY);
    if (!token) {
      state.status = 'no_token'; state.token = '';
      log('NO_TOKEN', '未登录，等待登录（检测到新 token 会自动开始心跳）');
      return;
    }

    const time = Date.now();
    const headers = {
      'Content-Type': 'application/json;charset=utf-8',
      'Authorization': 'Bearer ' + token,
      'time': String(time),
      'X-Nonce': nonce(),
      'sign': makeSign(token, time)
    };
    const started = Date.now();
    let status = 0, text = '', channel = '页面 fetch';

    try {
      const r = await W.fetch(API, { method: 'GET', headers: headers, credentials: 'same-origin', cache: 'no-store' });
      status = r.status; text = await r.text();
    } catch (e) { text = e.message; }

    // 网关要求 Referer；沙箱 fetch 若被 403，改用扩展通道显式带 Referer
    if (status === 403 || status === 0) {
      channel = 'GM_xhr';
      const r2 = await gmFetch(API, Object.assign({}, headers, { 'Referer': location.href }));
      status = r2.status; text = r2.text;
    }

    let code = null;
    try { code = JSON.parse(text).code; } catch (e) { /* 非 JSON 响应 */ }
    state.http = status; state.code = code; state.ms = Date.now() - started;
    state.channel = channel; state.token = fp(token); state.lastBeat = Date.now();

    if (status === 401 || code === 401) {
      state.status = 'expired'; state.failCount++;
      state.lastErr = '服务端返回 401，会话已失效';
      log('EXPIRED', 'HTTP ' + status + ' code=401 · ' + state.ms + 'ms · ' + channel);
    } else if (status >= 200 && status < 300 && code === 200) {
      state.status = 'ok'; state.okCount++; state.lastOk = Date.now(); state.lastErr = '';
      log('OK', 'HTTP ' + status + ' code=200 · ' + state.ms + 'ms · ' + channel);
    } else {
      state.status = 'error'; state.failCount++;
      state.lastErr = 'HTTP ' + status + ' ' + String(text).slice(0, 70);
      log('FAIL', state.lastErr);
    }
  }

  /* ---------- token 变化 / 掉线取证 ---------- */
  function checkToken() {
    const now = !!LS.getItem(TOKEN_KEY);
    if (hadToken && !now) {
      state.type = LS.getItem('type') || '';
      state.gap = LS.getItem('time') || '';
      let reason = 'token 被清除，无 close/refresh 标记 → 服务端会话到期后前端登出';
      if (state.type === 'close') reason = '页面被判定为关闭（系统 fetchLogOut 删 token 并上报 browserClosed）';
      else if (state.type === 'refresh') reason = '页面刷新触发的卸载（系统判定 refresh）';
      if (/login/.test(location.href)) reason += '；当前已跳转登录页';
      state.reason = reason;
      state.status = 'logged_out';
      log('TOKEN_GONE', reason + '；最后一次成功心跳 ' + hhmmss(state.lastOk));
    } else if (!hadToken && now) {
      log('LOGIN', '检测到新 token，立即开始心跳');
      state.reason = '';
      heartbeat();
    }
    hadToken = now;
  }

  function readBootMarks() {
    const type = LS.getItem('type'), gap = LS.getItem('time');
    if (type) log('UNLOAD_MARK', '系统卸载标记 type=' + type + ' gap=' + gap + 'ms');
    if (document.wasDiscarded) log('DISCARDED', '标签页曾被浏览器丢弃后恢复');
    log('BOOT', 'v3 已注入 · ' + location.pathname + ' · token ' + (LS.getItem(TOKEN_KEY) ? '有' : '无'));
  }

  /* ---------- 可见状态条（不再只靠小圆点，装没装一眼可见） ---------- */
  let bar, head, detail, expanded = false;
  function buildUI() {
    const style = document.createElement('style');
    style.textContent = `
      #ka3-bar{position:fixed;right:12px;bottom:12px;z-index:2147483000;max-width:360px;
        background:#fff;color:#303133;border:1px solid #dcdfe6;border-left:4px solid #e6a23c;
        border-radius:6px;box-shadow:0 3px 14px rgba(0,0,0,.14);font:12px/1.55 Consolas,Microsoft YaHei,monospace}
      #ka3-head{padding:7px 10px;cursor:pointer;white-space:pre-line}
      #ka3-detail{display:none;border-top:1px solid #ebeef5;padding:8px 10px;max-height:230px;overflow:auto;
        white-space:pre-wrap;word-break:break-all;color:#606266}
    `;
    bar = document.createElement('div'); bar.id = 'ka3-bar';
    head = document.createElement('div'); head.id = 'ka3-head';
    detail = document.createElement('div'); detail.id = 'ka3-detail';
    bar.appendChild(head); bar.appendChild(detail);
    document.head.appendChild(style);
    document.body.appendChild(bar);
    head.addEventListener('click', () => {
      expanded = !expanded;
      detail.style.display = expanded ? 'block' : 'none';
    });
  }

  function render() {
    if (!head) return;
    const color = !enabled ? '#9aa0a6'
      : state.status === 'ok' ? '#67c23a'
      : (state.status === 'error' || state.status === 'expired' || state.status === 'logged_out' || state.status === 'no_token') ? '#f56c6c'
      : '#e6a23c';
    bar.style.borderLeftColor = color;
    const line1 = '保活 v3  ' + (enabled ? '运行中' : '已暂停') + '  间隔 ' + minutes + ' 分  （点开看日志）';
    const line2 = state.status === 'no_token'
      ? '未登录 · 等待登录（登录后自动开始）'
      : state.http !== null
        ? '心跳 HTTP ' + state.http + ' code=' + state.code + ' · ' + hhmmss(state.lastBeat) + ' · 连续成功 ' + state.okCount + ' 次'
        : '等待首次心跳…';
    const line3 = state.lastErr ? '异常：' + state.lastErr.slice(0, 90)
      : state.reason ? '上次掉线：' + state.reason.slice(0, 90) : '';
    head.textContent = [line1, line2, line3].filter(Boolean).join('\n');
    detail.textContent = state.logs.slice().reverse().map(r => hhmmss(r.t) + ' [' + r.kind + '] ' + r.msg).join('\n');
  }

  /* ---------- 调度 ---------- */
  function restart() {
    if (timer) clearInterval(timer);
    if (watchTimer) clearInterval(watchTimer);
    timer = null; watchTimer = null;
    render();
    if (!enabled) return;
    heartbeat();
    timer = setInterval(heartbeat, Math.max(1, minutes) * 60 * 1000);
    watchTimer = setInterval(checkToken, 5000);
  }

  function toggle() {
    enabled = !enabled;
    try { GM_setValue('enabled', enabled); } catch (e) { /* 忽略 */ }
    log('CONFIG', enabled ? '已开启' : '已暂停');
    restart();
  }

  function diagText() {
    const lines = [
      '=== 评标系统保活诊断 v3 ===',
      '导出时间：' + new Date().toLocaleString('zh-CN'),
      '状态：' + state.status + ' · 启用：' + enabled + ' · 间隔：' + minutes + ' 分',
      '首次运行：' + hhmmss(state.bootAt) + ' · 最后心跳：' + hhmmss(state.lastBeat) + ' · 最后成功：' + hhmmss(state.lastOk),
      '成功 ' + state.okCount + ' 次 / 失败 ' + state.failCount + ' 次',
      '上次掉线：' + (state.reason || '尚无记录'),
      '卸载标记：type=' + (state.type || '(无)') + ' gap=' + (state.gap || '(无)'),
      '--- 最近日志 ---'
    ];
    state.logs.slice().reverse().forEach(r => lines.push(hhmmss(r.t) + ' [' + r.kind + '] ' + r.msg));
    return lines.join('\n');
  }

  GM_registerMenuCommand('开启 / 暂停保活', toggle);
  GM_registerMenuCommand('立刻发送一次心跳', heartbeat);
  GM_registerMenuCommand('设置心跳间隔（分钟）', () => {
    const v = prompt('心跳间隔（分钟，建议 2–5）', String(minutes));
    if (v === null) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1 || n > 60) { alert('请输入 1–60 之间的数字'); return; }
    minutes = n;
    try { GM_setValue('minutes', n); } catch (e) { /* 忽略 */ }
    log('CONFIG', '间隔改为 ' + n + ' 分钟');
    restart();
  });
  GM_registerMenuCommand('复制诊断日志（发给我排查）', () => {
    const t = diagText();
    try { GM_setClipboard(t); alert('诊断日志已复制到剪贴板，直接粘贴发来即可'); }
    catch (e) { prompt('手动复制以下日志：', t); }
  });
  GM_registerMenuCommand('清除日志', () => {
    state.logs = []; state.reason = ''; state.type = ''; state.gap = '';
    try { GM_setValue(K_LOG, []); } catch (e) { /* 忽略 */ }
    save();
  });

  // 页面生命周期事件：只记录，不干预系统登出逻辑
  document.addEventListener('visibilitychange', () => {
    if (enabled && !document.hidden && Date.now() - state.lastOk > 60000) heartbeat();
  });
  document.addEventListener('freeze', () => log('FREEZE', '浏览器冻结了本标签页'));
  document.addEventListener('resume', () => { log('RESUME', '标签页从冻结恢复'); if (enabled) heartbeat(); });
  W.addEventListener('pagehide', e => log('PAGEHIDE', '页面隐藏/卸载 persisted=' + !!e.persisted));
  W.addEventListener('pageshow', e => { log('PAGESHOW', '页面显示 persisted=' + !!e.persisted); if (enabled) heartbeat(); });

  function boot() {
    buildUI();
    readBootMarks();
    checkToken();
    restart();
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
