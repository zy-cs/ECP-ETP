// ==UserScript==
// @name         ECP 开标记录 · 单页全显 + 复制明细
// @namespace    local.ecp.openbid
// @version      4.5
// @description  国网 ECP 2.0 开标记录表：单页全显全部开标明细 + 复制（含表头 TSV）。优先通过 DevExtreme 实例将分页大小设为 300 条/页；若拿不到组件实例（ECP 现状），自动改用“逐页收集全部明细 + 注入完整表格”兜底，收集完成后彻底停止遍历。v4.5 修复两处问题：① 去掉“前5列签名”误杀式去重（导致缺明细），改整行级安全去重；② 不再隐藏原网格，原网页分页条保持可见。支持 GitHub 自动更新。纯浏览器本地展示增强，只读、不提交、不改服务端数据。
// @author       JIUYF
// @match        https://ecp.sgcc.com.cn/ecp2.0/purchase_ext/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/zy-cs/ECP-ETP
// @supportURL   https://github.com/zy-cs/ECP-ETP/issues
// @updateURL    https://raw.githubusercontent.com/zy-cs/ECP-ETP/main/ecp_openbid_onepage.user.js
// @downloadURL  https://raw.githubusercontent.com/zy-cs/ECP-ETP/main/ecp_openbid_onepage.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * 单例守卫：解决「页面上出现两条工具条」
   * 常见原因：Tampermonkey 里同一脚本装了两份，或同一版本被注入两次。
   * 注意：@grant none 时脚本运行在页面上下文，window 标记可跨实例共享。
   * ============================================================ */
  var CTRL_KEY = '__ECP_OPENBID_CTRL__';
  var VERSION = 4.5;
  var BAR_ATTR = 'data-ecp-openbid-bar';

  var prev = window[CTRL_KEY];
  if (prev && prev.version >= VERSION) return;               // 已有 v4.2 在跑，本实例直接退出
  if (document.querySelector('[' + BAR_ATTR + '="v4"]')) return; // DOM 兜底
  if (prev && typeof prev.destroy === 'function') {
    try { prev.destroy(); } catch (e) {}                    // 让更低版本交出控制权
  }

  // v2 遗留的工具条：隐藏而不是删除。删掉会让旧实例的 state.bar.isConnected
  // 变成 false，从而又插一条新的，反而越清越多。
  function hideLegacyBars() {
    var nodes = document.querySelectorAll('.ecp-ka-bar, .ecp-ka-hint');
    var changed = false;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.getAttribute(BAR_ATTR) === 'v4') continue;
      if (el.getAttribute('data-ecp-legacy-hidden') !== '1') {
        el.style.display = 'none';
        el.setAttribute('data-ecp-legacy-hidden', '1');
        changed = true;
      }
    }
    return changed;
  }
  hideLegacyBars();

  var CFG = {
    headMarkers: ['应答人名称', '折扣率', '分标名称', '投标价格', '开标备注'],
    pageSize: 300,        // 单页显示条数：改成所需值即可（如 500）。≤该值的分标会全部显示在一页
    stableMs: 400,        // 表格「只渲染了 1 行」时的等待间隔
    stableTries: 12,
    maxApplyTries: 40,    // 拿不到组件实例时最多尝试次数，避免持续扫描
    debug: false
  };

  var state = {
    bar: null,
    timer: null,
    suppress: false,
    busy: false,
    stopped: false,
    applied: false,       // 是否已成功把 pageSize 设为目标值（设过后不再自动调度 run）
    tries: 0,             // 已尝试应用次数
    lastInfo: null,
    diag: '',
    instDiag: '',       // 组件实例探测诊断，便于排查拿不到实例的问题
    merged: false,      // 是否已单页全显完成（完成后彻底停止，杜绝遍历）
    mergedRows: null,   // 收集到的全部明细行，供复制使用
    mergedHeads: null   // 对应的表头
  };

  function log() {
    if (!CFG.debug) return;
    console.log.apply(console, ['[ECP 明细增强 v4]'].concat([].slice.call(arguments)));
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clean(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/\t/g, ' ').replace(/\r|\n/g, ' ');
  }
  function esc(v) { return clean(v).replace(/\t/g, ' '); }

  /* ---------- 目标表格识别（纯 DOM，不依赖 window.DevExpress） ---------- */

  // DevExtreme 有「表头 table」和「表体 table」两张同名 table，必须精确取表体
  function bodyTable(root) {
    if (!root) return null;
    return root.querySelector('.dx-datagrid-rowsview table.dx-datagrid-table') ||
           root.querySelector('.dx-datagrid-rowsview table') ||
           root.querySelector('table.dx-datagrid-table') ||
           root.querySelector('table');
  }

  function findTarget() {
    var tables = document.querySelectorAll('table');
    var best = null;
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      var labs = t.querySelectorAll('td[aria-label]');
      var joined = '';
      for (var j = 0; j < labs.length; j++) joined += (labs[j].getAttribute('aria-label') || '') + ' | ';
      var hits = 0;
      for (var k = 0; k < CFG.headMarkers.length; k++) {
        if (joined.indexOf(CFG.headMarkers[k]) >= 0) hits++;
      }
      if (hits < 2) { // 普通 table：表头 <th> 文本
        var ths = t.querySelectorAll('th');
        var htxt = '', h2 = 0;
        for (var q = 0; q < ths.length; q++) htxt += clean(ths[q].textContent) + ' | ';
        for (var k2 = 0; k2 < CFG.headMarkers.length; k2++) {
          if (htxt.indexOf(CFG.headMarkers[k2]) >= 0) h2++;
        }
        if (h2 > hits) hits = h2;
      }
      if (hits < 2) { // DevExtreme：表头在另一张 table 里
        var rr = t.closest('.dx-datagrid');
        var ht = rr && rr.querySelector('.dx-datagrid-headers table');
        if (ht) {
          var htxt2 = clean(ht.textContent), h3 = 0;
          for (var k3 = 0; k3 < CFG.headMarkers.length; k3++) {
            if (htxt2.indexOf(CFG.headMarkers[k3]) >= 0) h3++;
          }
          if (h3 > hits) hits = h3;
        }
      }
      var rowCount = t.querySelectorAll('tbody tr.dx-data-row').length ||
                     t.querySelectorAll('tbody tr').length;
      if (hits >= 2 && rowCount > 0 && (!best || rowCount > best.rowCount)) {
        best = { table: t, rowCount: rowCount };
      }
    }
    if (!best) return null;

    var table = best.table;
    var root = table.closest('.dx-datagrid') ||
               table.closest('.dx-datagrid-rowsview') ||
               table.parentElement;
    // 优先取「属于这张明细表」的分页条，避免误抓页面上其它表格的 pager
    var pager = null;
    if (root) {
      pager = root.querySelector('.dx-datagrid-pager, .dx-pager');
      if (!pager && root.parentElement) {
        pager = root.parentElement.querySelector('.dx-datagrid-pager, .dx-pager');
      }
    }
    if (!pager) pager = document.querySelector('.dx-datagrid-pager, .dx-pager');
    var tbody = table.querySelector('tbody') || table;
    return { table: table, tbody: tbody, root: root, pager: pager };
  }

  /* ---------- 行解析：靠 td 的 aria-label「列 XXX, 值 YYY」拿列名 ---------- */

  function parseCells(tds) { // 纯函数；tds = [{label, text}]
    var cells = [];
    for (var i = 0; i < tds.length; i++) {
      var td = tds[i];
      var label = td.label || '';
      var m = /^列\s+(.+?),\s*值/.exec(label);
      if (m) {
        cells.push({ name: clean(m[1]), value: clean(td.text) });
      } else if (/选择行/.test(label) || /dx-command-select/.test(label)) {
        continue; // 复选框列
      } else {
        cells.push({ name: '', value: clean(td.text) });
      }
    }
    return cells;
  }

  function readRows(table) {
    var trs = table.querySelectorAll('tbody tr.dx-data-row');
    if (!trs.length) trs = table.querySelectorAll('tbody tr');
    var out = [];
    for (var i = 0; i < trs.length; i++) {
      var tr = trs[i];
      if (tr.classList && (tr.classList.contains('dx-freespace-row') ||
                           tr.classList.contains('dx-virtual-row'))) continue;
      var tds = tr.querySelectorAll('td');
      var desc = [];
      for (var j = 0; j < tds.length; j++) {
        desc.push({
          label: tds[j].getAttribute('aria-label') ||
                 (tds[j].classList.contains('dx-command-select') ? 'dx-command-select' : ''),
          text: tds[j].textContent
        });
      }
      var cells = parseCells(desc);
      if (!cells.length) continue;
      out.push({ cells: cells });
    }
    return out;
  }

  // 复制结果的第一行固定为表头：优先取原网页表头 table 的可见列名，
  // 列数对不上再退回到单元格 aria-label 的列名，最后才是「列N」。
  function deriveHeads(rows, root) {
    var colCount = rows.length ? rows[0].cells.length : 0;
    var names = [];
    var ht = root && root.querySelector('.dx-datagrid-headers table');
    if (!ht && root && root.parentElement) {
      ht = root.parentElement.querySelector('.dx-datagrid-headers table');
    }
    if (ht) {
      var hdrs = ht.querySelectorAll('tr.dx-header-row > td, tr.dx-header-row > th, th');
      for (var i = 0; i < hdrs.length; i++) {
        var n = clean(hdrs[i].textContent);
        if (n && !/选择/.test(n)) names.push(n);
      }
      if (names.length === colCount && names.length) return names;
      if (names.length !== colCount) names = [];
    }
    if (rows.length && rows[0].cells.some(function (c) { return c.name; })) {
      return rows[0].cells.map(function (c, idx) { return c.name || ('列' + (idx + 1)); });
    }
    if (!names.length && rows.length) {
      names = rows[0].cells.map(function (c, idx) { return c.name || ('列' + (idx + 1)); });
    }
    return names;
  }

  function buildTSV(rows, heads) {
    var h = heads && heads.length ? heads : [];
    if (!h.length && rows.length) {
      h = rows[0].cells.map(function (c, i) { return c.name || ('列' + (i + 1)); });
    }
    var lines = [h.map(esc).join('\t')];
    var seqIdx = h.findIndex(function (n) { return /^序号$/.test(n); });
    for (var r = 0; r < rows.length; r++) {
      var vals = [];
      for (var c = 0; c < h.length; c++) {
        var v = rows[r].cells[c] ? rows[r].cells[c].value : '';
        if (c === seqIdx) v = String(r + 1); // 序号重排
        vals.push(esc(v));
      }
      lines.push(vals.join('\t'));
    }
    return { text: lines.join('\r\n'), rowCount: rows.length, colCount: h.length };
  }

  /* ---------- DevExtreme 实例：只用来改分页大小，绝不合并/改组件渲染 ---------- */

  // DevExtreme 在不同打包方式下全局名可能不同（本例 window.DevExpress 就是“无”）；
  // 缓存一次查找结果，避免每次调度都遍历 window。
  var _dxGlobal = null, _dxSearched = false;
  function getDX() {
    if (_dxSearched) return _dxGlobal;
    _dxSearched = true;
    if (window.DevExpress) { _dxGlobal = window.DevExpress; return _dxGlobal; }
    try {
      for (var k in window) {
        if (/dev[eE]xpress/i.test(k) && window[k] && typeof window[k] === 'object' && window[k].ui) {
          _dxGlobal = window[k]; break;
        }
      }
    } catch (e) {}
    return _dxGlobal;
  }

  function tryInstance(root) {
    var report = [];
    var candidates = [];
    var seeds = [root, document].filter(Boolean);
    for (var s = 0; s < seeds.length; s++) {
      var ctx = seeds[s];
      if (!ctx || !ctx.querySelectorAll) continue;
      var els = ctx.querySelectorAll('.dx-datagrid, .dx-treegrid, .dx-gridbase, [class*="dx-datagrid"]');
      for (var i = 0; i < els.length; i++) if (candidates.indexOf(els[i]) < 0) candidates.push(els[i]);
    }
    report.push('候选网格=' + candidates.length);
    var DX = getDX();
    report.push('DX全局=' + (DX ? '有' : '无'));
    var JQ = window.jQuery || window.$;
    report.push('jQuery=' + (JQ ? '有' : '无'));
    for (var c = 0; c < candidates.length; c++) {
      var el = candidates[c];
      try {
        if (DX && DX.ui && DX.ui.dxDataGrid && DX.ui.dxDataGrid.getInstance) {
          var gi = DX.ui.dxDataGrid.getInstance(el);
          if (gi) { report.push('getInstance命中'); state.instDiag = report.join(' | '); return gi; }
        }
      } catch (e) { report.push('getInstance抛错'); }
      try {
        if (JQ && typeof JQ(el).dxDataGrid === 'function') {
          var gj = JQ(el).dxDataGrid('instance');
          if (gj) { report.push('jQuery命中'); state.instDiag = report.join(' | '); return gj; }
        }
      } catch (e) { report.push('jQuery抛错'); }
      try {
        if (el.dxDataGrid && typeof el.dxDataGrid.option === 'function') {
          report.push('元素属性命中'); state.instDiag = report.join(' | '); return el.dxDataGrid;
        }
      } catch (e) {}
      try {
        if (JQ && JQ(el).data) {
          var dc = JQ(el).data('dxDataGrid');
          if (!dc && JQ(el).data('dxComponents')) dc = JQ(el).data(JQ(el).data('dxComponents')[0]);
          if (dc && typeof dc.option === 'function') { report.push('data命中'); state.instDiag = report.join(' | '); return dc; }
        }
      } catch (e) {}
    }
    report.push('结论=未拿到实例');
    state.instDiag = report.join(' | ');
    return null;
  }

  function instanceTotalCount(root) {
    var g = tryInstance(root);
    if (!g || typeof g.totalCount !== 'function') return 0;
    try { return g.totalCount() || 0; } catch (e) { return 0; }
  }

  // 核心：通过 DevExtreme 实例把分页大小设为 CFG.pageSize（默认 300）。
  // 同时把滚动模式改为 standard，让当前页全部行一次性渲染进 DOM：
  //   1) 保证「复制当前页明细」能读到全部行（虚拟滚动只渲染可视窗口会漏行）；
  //   2) 消除虚拟滚动视口 transform 可能带来的渲染错位 / 中部黑条。
  // 保留分页（不禁用 paging.enabled），原网页页码始终可点击切换；
  // 不做任何 tbody 合并 / transform 覆盖，彻底避免持续遍历。
  function applyPageSize(target) {
    var g = tryInstance(target && target.root);
    if (!g) { log('无组件实例，无法设置 pageSize'); return false; }
    try {
      if (typeof g.option === 'function') {
        g.option('paging.pageSize', CFG.pageSize);
        try { g.option('scrolling.mode', 'standard'); } catch (e) {} // 整页渲染，便于读取与消除黑条
      }
      if (typeof g.pageSize === 'function') g.pageSize(CFG.pageSize);
      if (typeof g.refresh === 'function') g.refresh();
      return true;
    } catch (e) { log('applyPageSize 失败', e); return false; }
  }

  /* ---------- 原网页分页信息：解析「第1页. 共6页 (总计59条数据)」 ---------- */

  function collectPagerTexts(pager) {
    var texts = [];
    function push(t) {
      t = clean(t);
      if (t && texts.indexOf(t) < 0) texts.push(t);
    }
    var nodes = [];
    if (pager) nodes.push(pager);
    var all = document.querySelectorAll('.dx-datagrid-pager, .dx-pager, .dx-info');
    for (var i = 0; i < all.length; i++) {
      if (nodes.indexOf(all[i]) < 0) nodes.push(all[i]);
    }
    for (var j = 0; j < nodes.length; j++) {
      var info = nodes[j].querySelector ? nodes[j].querySelector('.dx-info') : null;
      push(info ? info.textContent : '');
      push(nodes[j].textContent || '');
    }
    return texts;
  }

  function pagerInfo(pager) {
    var texts = collectPagerTexts(pager);
    var out = { pages: 1, total: 0, current: 1, text: '' };
    for (var i = 0; i < texts.length; i++) {
      var txt = texts[i];
      var m = /第\s*(\d+)\s*页[\s\S]*?共\s*(\d+)\s*页[\s\S]*?总计\s*(\d+)\s*条/.exec(txt);
      var mt = /总计\s*(\d+)\s*条/.exec(txt);
      var mp = /共\s*(\d+)\s*页/.exec(txt);
      var mc = /共\s*(\d+)\s*(?:条数据|条记录|条|项)/.exec(txt);
      var me = /(\d+)\s*items?/i.exec(txt);
      var mpe = /\bof\s*(\d+)\b/i.exec(txt);
      var total = m ? parseInt(m[3], 10)
                    : (mt ? parseInt(mt[1], 10)
                          : (mc ? parseInt(mc[1], 10) : (me ? parseInt(me[1], 10) : 0)));
      var pages = m ? parseInt(m[2], 10)
                    : (mp ? parseInt(mp[1], 10) : (mpe ? parseInt(mpe[1], 10) : 1));
      var mcur = /第\s*(\d+)\s*页/.exec(txt);
      var current = mcur ? parseInt(mcur[1], 10) : 1;
      if (total > 0) {
        out = { pages: Math.max(1, pages), total: total, current: current, text: txt };
        break;
      }
      if (pages > 1 && !out.text) out = { pages: pages, total: 0, current: current, text: txt };
    }
    return out;
  }

  // v3 会把页码按钮锁成不可点；这里只负责把可能残留的锁定/隐藏恢复，保证页码可点
  function unlockPager(pager) {
    if (!pager) return;
    if (pager.style.display === 'none') pager.style.display = '';
    if (pager.getAttribute('data-ecp-readonly') === '1') {
      pager.removeAttribute('data-ecp-readonly');
      pager.removeAttribute('title');
    }
    var cs = pager.querySelectorAll('[data-ecp-locked="1"]');
    for (var i = 0; i < cs.length; i++) {
      cs[i].style.pointerEvents = '';
      cs[i].removeAttribute('data-ecp-locked');
      cs[i].removeAttribute('aria-disabled');
    }
  }
  function unlockAllPagers() {
    var ps = document.querySelectorAll('.dx-datagrid-pager, .dx-pager');
    for (var i = 0; i < ps.length; i++) unlockPager(ps[i]);
  }
  function restorePagers() {
    var ps = document.querySelectorAll('.dx-datagrid-pager, .dx-pager');
    var changed = false;
    for (var i = 0; i < ps.length; i++) {
      if (ps[i].style.display === 'none') { ps[i].style.display = ''; changed = true; }
    }
    return changed;
  }

  // 表格刚渲染时可能只有 1 行（加载中/占位行），此时开跑会得到「共 1 条」
  function waitStable(target) {
    return new Promise(function (resolve) {
      var tries = 0;
      (function check() {
        var t = findTarget() || target;
        var attached = t && t.table && document.contains(t.table);
        var info = pagerInfo(t && t.pager);
        var n = attached ? readRows(t.table).length : 0;
        if (tries < CFG.stableTries && (!attached || (n <= 1 && info.total !== 1))) {
          tries++;
          setTimeout(check, CFG.stableMs);
          return;
        }
        resolve(attached ? t : (findTarget() || target));
      })();
    });
  }

  /* ---------- 拿不到实例时的兜底：一次性有界翻页收集 + 注入完整表格 ---------- */

  // 拿不到 DevExtreme 实例时（ECP 现状），用「回到第 1 页 → 逐页点下一页」的方式
  // 把全部明细收集齐，再渲染成一张完整表格。这是「有界」一次性遍历，收集完成后
  // state.merged 守卫让脚本彻底停止，不会再持续扫描 DOM。
  // 关键修正（v4.5）：
  //   1) 不再用「前 5 列签名」去重——它会在同分标不同页的行上误杀，导致缺明细；
  //      改为仅在「整行完全一致」时才去重（防止某页被重复读取造成重复行）。
  //   2) 先确保停在「第 1 页」（反复点上一页直到禁用），再逐页前进，彻底解决
  //      「页面停在最后一页、只收集到残行」的问题。
  //   3) 收集完不隐藏原网格，原网页分页条保持可见。

  function curRowCount(t) {
    var c = t || findTarget();
    var tb = c && c.tbody;
    return tb ? (tb.querySelectorAll('tr.dx-data-row').length || tb.querySelectorAll('tr').length) : 0;
  }
  // 等待「行数变化」作为翻页完成的信号（比读选中页码更稳，避免页码按钮窗口化问题）
  function waitRowChange(target, prevCount) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function check() {
        var n = curRowCount(target);
        if (n && n !== prevCount) return resolve(true);
        if (Date.now() - start > 6000) return resolve(false);
        setTimeout(check, 100);
      })();
    });
  }
  // 反复点「上一页」直到禁用，确保从第 1 页开始收集
  function ensurePageOne(pager, target) {
    return new Promise(function (resolve) {
      var guard = 0, cap = 40;
      try { cap = (pagerInfo(pager).pages || 1) + 5; } catch (e) {}
      (function loop() {
        var prev = pager.querySelector('.dx-prev-button:not(.dx-state-disabled)');
        if (!prev || guard++ > cap) return resolve();
        prev.click();
        setTimeout(loop, 200);
      })();
    });
  }
  function rowKey(row) {
    var s = '';
    for (var i = 0; i < row.cells.length; i++) s += (row.cells[i] ? row.cells[i].value : '') + '\u0001';
    return s;
  }
  function collectAll(target) {
    var info = pagerInfo(target.pager);
    var pages = Math.max(1, info.pages);
    var total = info.total || 0;
    function readCur() { var c = findTarget() || target; return readRows(c.table); }
    function run() {
      var collected = [], seen = {};
      function append(rows) {
        for (var i = 0; i < rows.length; i++) {
          var k = rowKey(rows[i]);
          if (!seen[k]) { seen[k] = 1; collected.push(rows[i]); }
        }
      }
      return ensurePageOne(target.pager, target).then(function () {
        function step(i) {
          if (i >= pages) return Promise.resolve();
          append(readCur());                                       // 读当前页
          if (i === pages - 1) return Promise.resolve();            // 最后一页已读，结束
          var before = curRowCount(target);
          var nx = target.pager.querySelector('.dx-next-button:not(.dx-state-disabled)');
          if (!nx) return Promise.resolve();
          nx.click();
          return waitRowChange(target, before).then(function () {
            return new Promise(function (r) { setTimeout(function () { step(i + 1).then(r); }, 100); });
          });
        }
        return step(0);
      }).then(function () { return collected; });
    }
    return run().then(function (rows) {
      // 数量不足（翻页偶发未生效）则整体重收一次
      if (total && rows.length < total) {
        return run().then(function (r2) { return r2.length >= rows.length ? r2 : rows; });
      }
      return rows;
    });
  }

  // 把收集到的全部明细渲染成一张干净的原生表格（不碰 DevExtreme 内部样式，避免黑条）。
  // 关键修正（v4.5）：【不再隐藏原网格】，原网页分页条保持可见、可点；完整表格插入到
  // 原网格之前，作为“单页全显”的明细视图。复制按钮直接读这张表的数据。
  function renderFullTable(target, rows, heads, info) {
    var box = document.createElement('div');
    box.className = 'ecp-full-table-box';
    box.setAttribute(BAR_ATTR, 'full');
    box.style.cssText = 'margin:8px 0;max-height:75vh;overflow:auto;border:1px solid #d7e0de;border-radius:4px;background:#fff;';
    var cap = document.createElement('div');
    cap.style.cssText = 'padding:8px 12px;background:#e8f5f2;color:#0b6b63;font:13px/1.5 "Microsoft YaHei",sans-serif;border-bottom:1px solid #d7e0de;';
    cap.textContent = '全部明细（单页全显 · 共 ' + rows.length + ' 条；原网页分页条已保留在下方）';
    box.appendChild(cap);
    var table = document.createElement('table');
    table.style.cssText = 'border-collapse:collapse;width:100%;font:13px/1.5 "Microsoft YaHei",sans-serif;';
    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    for (var h = 0; h < heads.length; h++) {
      var th = document.createElement('th');
      th.textContent = heads[h];
      th.style.cssText = 'position:sticky;top:0;background:#009688;color:#fff;padding:6px 8px;border:1px solid #cfe3df;text-align:left;white-space:nowrap;';
      htr.appendChild(th);
    }
    thead.appendChild(htr); table.appendChild(thead);
    var tb = document.createElement('tbody');
    for (var r = 0; r < rows.length; r++) {
      var tr = document.createElement('tr');
      if (r % 2) tr.style.background = '#f7faf9';
      for (var c = 0; c < heads.length; c++) {
        var td = document.createElement('td');
        td.textContent = (rows[r].cells[c] ? rows[r].cells[c].value : '');
        td.style.cssText = 'padding:5px 8px;border:1px solid #eef2f1;white-space:nowrap;';
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    box.appendChild(table);
    // 注意：故意不隐藏原网格 —— 保留原网页分页条
    var host = (target.root && target.root.parentNode) ? target.root : (target.table && target.table.parentNode);
    if (host && host.parentNode) host.parentNode.insertBefore(box, host);
  }

  /* ---------- 工具条 ---------- */

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; })
        .catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function ensureBar(target) {
    if (state.bar && state.bar.wrap && state.bar.wrap.isConnected) return state.bar;
    // 清掉本版本遗留的重复工具条，保证页面上永远只有一条
    var mine = document.querySelectorAll('[' + BAR_ATTR + '="v4"]');
    for (var i = 0; i < mine.length; i++) {
      if (mine[i].parentNode) mine[i].parentNode.removeChild(mine[i]);
    }
    hideLegacyBars();
    var host = target.root;
    if (!host || !host.parentNode) return null;

    var wrap = document.createElement('div');
    wrap.className = 'ecp-ka-bar';
    wrap.setAttribute(BAR_ATTR, 'v4');
    wrap.style.cssText = [
      'display:flex', 'align-items:center', 'gap:10px', 'flex-wrap:wrap',
      'margin:8px 0', 'padding:8px 12px', 'background:#fff',
      'border:1px solid #d7e0de', 'border-left:3px solid #009688',
      'border-radius:4px', 'font:13px/1.6 "Microsoft YaHei",sans-serif',
      'color:#2c2c2a', 'z-index:10'
    ].join(';');

    var tag = document.createElement('span');
    tag.textContent = 'ECP 明细增强 v4';
    tag.title = '作者：JIUYF · 开源仓库：https://github.com/zy-cs/ECP-ETP · 已启用 GitHub 自动更新';
    tag.style.cssText = 'color:#009688;font-weight:600;white-space:nowrap;';

    var author = document.createElement('span');
    author.textContent = 'by JIUYF';
    author.title = 'GitHub: https://github.com/zy-cs/ECP-ETP';
    author.style.cssText = 'color:#9aa6a3;font-size:12px;white-space:nowrap;';

    function mkBtn(text, primary, title) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = text; b.title = title || '';
      b.style.cssText = primary
        ? 'padding:4px 14px;background:#009688;color:#fff;border:0;border-radius:3px;cursor:pointer;font:13px "Microsoft YaHei",sans-serif;'
        : 'padding:3px 10px;background:#fff;color:#009688;border:1px solid #009688;border-radius:3px;cursor:pointer;font:13px "Microsoft YaHei",sans-serif;';
      return b;
    }
    var btn = mkBtn('复制全部明细（含表头 TSV）', true, '复制已单页全显的全部明细行，第一行是原网页表头，制表符分隔，粘到 Excel/WPS 直接分列');
    var redo = mkBtn('重新应用', false, '网格重绘或切换分标后点这里重新收集全部明细');
    var diag = mkBtn('诊断信息', false, '复制运行环境信息，用于排查');

    var status = document.createElement('span');
    status.style.cssText = 'color:#5f5e5a;font-size:12px;';
    status.textContent = '正在识别表格…';

    // 常驻显示原网页分页信息，即便分页条在页面底部看不见也能看到总条数
    var origin = document.createElement('span');
    origin.style.cssText = 'color:#0b6b63;font-size:12px;white-space:nowrap;';
    origin.textContent = '原网页分页：读取中…';

    wrap.appendChild(tag); wrap.appendChild(author); wrap.appendChild(btn); wrap.appendChild(redo);
    wrap.appendChild(diag); wrap.appendChild(status); wrap.appendChild(origin);
    host.parentNode.insertBefore(wrap, host);

    var lastColor = '';
    var bar = {
      wrap: wrap, status: status, origin: origin, rows: null, heads: null,
      // 内容相同就不写 DOM，避免反复触发 MutationObserver 自循环
      setStatus: function (s, bad) {
        if (status.textContent !== s) status.textContent = s;
        var c = bad === false ? '#a32d2d' : (bad === true ? '#009688' : '#5f5e5a');
        if (lastColor !== c) { status.style.color = c; lastColor = c; }
      },
      setOrigin: function (info, rowsLen) {
        var text;
        if (info && info.text) {
          var raw = info.text.length > 90 ? info.text.slice(0, 90) + '…' : info.text;
          text = '原网页分页：' + raw +
            (info.total ? ' · 总计 ' + info.total + ' 条数据' : '');
        } else {
          text = '原网页分页：未读取到总条数（当前页 ' + (rowsLen || 0) + ' 行，点「诊断信息」）';
        }
        if (origin.textContent !== text) origin.textContent = text;
      }
    };

    // 复制已单页全显的全部明细行（优先读收集结果；未收集时退化为当前页）
    btn.addEventListener('click', function () {
      var rows, heads;
      if (state.mergedRows && state.mergedRows.length) { rows = state.mergedRows; heads = state.mergedHeads; }
      else {
        var t = findTarget();
        if (!t) { bar.setStatus('未找到表格，请点「重新应用」', false); return; }
        rows = readRows(t.table); heads = deriveHeads(rows, t.root);
        if (!rows.length) { bar.setStatus('当前页没有可复制的行', false); return; }
      }
      var tsv = buildTSV(rows, heads);
      btn.disabled = true; bar.setStatus('正在复制…');
      copyText(tsv.text).then(function (ok) {
        btn.disabled = false;
        bar.setStatus(ok
          ? '已复制 ' + tsv.rowCount + ' 行 × ' + tsv.colCount + ' 列（第一行表头，粘 Excel 直接分列）'
          : '复制失败，请检查浏览器剪贴板权限', ok);
      });
    });
    redo.addEventListener('click', function () {
      // 先移除旧的全表、恢复原始网格显示，再重新收集
      var old = document.querySelectorAll('[' + BAR_ATTR + '="full"]');
      for (var i = 0; i < old.length; i++) if (old[i].parentNode) old[i].parentNode.removeChild(old[i]);
      if (target && target.root) target.root.style.display = '';
      state.merged = false; state.applied = false; state.tries = 0;
      run(true);
    });
    diag.addEventListener('click', function () {
      copyText(state.diag || '(暂无诊断信息)').then(function (ok) {
        bar.setStatus(ok ? '诊断信息已复制，粘贴发我即可' : '复制失败', ok);
      });
    });

    state.bar = bar;
    return bar;
  }

  function buildDiag(target, extra) {
    var DX = window.DevExpress && window.DevExpress.ui;
    var JQ = window.jQuery || window.$;
    var info = state.lastInfo || { pages: 1, total: 0, current: 1, text: '' };
    var cur = findTarget();
    var domRows = cur ? readRows(cur.table).length : 0;
    var lines = [
      'ECP 明细增强 v4 诊断',
      '时间: ' + new Date().toLocaleString('zh-CN'),
      'hash: ' + location.hash,
      '全局单例版本: ' + (window[CTRL_KEY] ? window[CTRL_KEY].version : '未注册'),
      '页面 v4 工具条数: ' + document.querySelectorAll('[' + BAR_ATTR + '="v4"]').length,
      '页面旧工具条数(已隐藏): ' + document.querySelectorAll('[data-ecp-legacy-hidden="1"]').length,
      'window.DevExpress: ' + (DX ? '有' : '无'),
      'window.jQuery: ' + (JQ ? '有' : '无'),
      '拿到组件实例: ' + (tryInstance(target && target.root) ? '是' : '否'),
      '实例诊断: ' + (state.instDiag || '-'),
      '页面 table 数: ' + document.querySelectorAll('table').length,
      'pager 节点数: ' + document.querySelectorAll('.dx-datagrid-pager, .dx-pager').length,
      'pager display: ' + (target && target.pager ? (target.pager.style.display || '(默认可见)') : '-'),
      '原分页文案: ' + (info.text || '(空)'),
      '原网页总条数: ' + info.total,
      '原分页页数: ' + info.pages,
      '目标单页大小: ' + CFG.pageSize,
      'DOM 当前行数: ' + domRows,
      '已单页全显: ' + (state.merged ? '是' : '否'),
      '已应用分页大小: ' + (state.applied ? '是' : '否'),
      '额外: ' + (extra || '-')
    ];
    state.diag = lines.join('\n');
  }

  /* ---------- 主流程 ---------- */

  function removeHint() {
    var h = document.querySelector('.ecp-ka-hint');
    if (h && h.parentNode) h.parentNode.removeChild(h);
  }

  function run(force) {
    if (state.stopped || state.busy) return;
    if (!force && state.merged) return;          // 已单页全显完成，坚决不再调度（杜绝遍历）
    unlockAllPagers();   // 兼容 v3 遗留锁定，保证原网页页码始终可点
    var target = findTarget();
    if (!target) {
      if (/open-bid-record/.test(location.hash)) {
        var hint = document.querySelector('.ecp-ka-hint');
        if (!hint) {
          hint = document.createElement('div');
          hint.className = 'ecp-ka-hint';
          hint.style.cssText = 'margin:8px;padding:8px 12px;background:#fff8e6;border:1px solid #efd9a8;border-radius:4px;font:13px "Microsoft YaHei",sans-serif;color:#854f0b;';
          hint.textContent = 'ECP 明细增强 v4 已注入，暂未识别到开标记录表格。加载完成后自动生效，或点「诊断信息」发我。';
          var body = document.querySelector('.body') || document.body;
          body.insertBefore(hint, body.firstChild);
        }
      }
      return;
    }
    removeHint();
    restorePagers();

    var bar = ensureBar(target);
    if (!bar) return;
    state.busy = true;
    state.tries++;
    var info0 = pagerInfo(target.pager);

    var g = tryInstance(target.root);
    if (g) {
      // 方案A（零遍历）：能拿到 DevExtreme 实例时，直接改分页大小让其原生渲染全部行
      bar.setStatus('正在把分页大小设为 ' + CFG.pageSize + ' 条/页…');
      var applied = applyPageSize(target);
      waitStable(target).then(function (stable) {
        var cur = findTarget() || stable;
        var rows = readRows(cur.table);
        if (!rows.length) { state.busy = false; state.applied = false; state.merged = false;
          bar.setStatus('暂未读到明细行，稍后自动重试…', false); return; }
        var heads = deriveHeads(rows, cur.root);
        var info = pagerInfo(cur.pager);
        state.lastInfo = info;
        bar.rows = rows; bar.heads = heads;
        state.applied = true; state.merged = true;   // 守卫：之后彻底停止
        state.mergedRows = rows; state.mergedHeads = heads;
        bar.setOrigin(info, rows.length);
        bar.setStatus('已设 ' + CFG.pageSize + ' 条/页 · 当前渲染 ' + rows.length + ' 行 · 复制请点按钮', true);
        buildDiag(cur, '方案=A(实例) applied=' + applied + ' total=' + info.total);
        state.busy = false;
      }).catch(function (e) {
        state.busy = false; state.applied = false; state.merged = false;
        bar.setStatus('实例设置失败：' + (e && e.message ? e.message : e) + '（点「重新应用」）', false);
        buildDiag(target, '方案=A失败 error=' + e);
      });
      return;
    }

    // 方案B（有界遍历一次）：拿不到实例（ECP 现状）→ 逐页收集全部明细，注入完整表格后停止
    bar.setStatus('正在逐页收集全部明细（共' + (info0.total || '?') + '条）…');
    waitStable(target).then(function () { return collectAll(target); }).then(function (rows) {
      if (!rows || !rows.length) {
        state.busy = false; state.merged = false; state.applied = false;
        bar.setStatus('暂未读到明细行，稍后自动重试…', false); return;   // 不改 merged，observer 继续重试
      }
      var info = pagerInfo(target.pager);
      var heads = deriveHeads(rows, target.root);
      renderFullTable(target, rows, heads, info);
      state.lastInfo = info;
      state.merged = true; state.applied = true;
      state.mergedRows = rows; state.mergedHeads = heads;
      bar.setOrigin(info, rows.length);
      bar.setStatus('已单页全显 ' + rows.length + ' 行（全部收集）· 点「复制全部明细」', true);
      buildDiag(target, '方案=B(翻页收集) 收集=' + rows.length + ' total=' + info.total);
      ensurePageOne(target.pager, target);   // 顺手把原网格拨回第 1 页，分页条更好看
      state.busy = false;
    }).catch(function (e) {
      state.busy = false; state.merged = false; state.applied = false;
      bar.setStatus('收集失败：' + (e && e.message ? e.message : e) + '（点「重新应用」）', false);
      buildDiag(target, '方案=B失败 error=' + e);
    });
  }

  function schedule(delay) {
    clearTimeout(state.timer);
    state.timer = setTimeout(function () { run(false); }, delay || 500);
  }

  // 观察者：只做轻量维护（恢复被隐藏的分页条 / 隐藏旧工具条）。
  // 关键：仅当「尚未成功设置分页大小」且「尝试未超限」时才自动调度 run；
  // 设成功后不再调度，DevExtreme 持续改写内联 style 也不会再触发遍历。
  var mo = new MutationObserver(function () {
    if (state.stopped || state.merged) return;   // 已单页全显：彻底停止，杜绝遍历
    var a = restorePagers();       // 任何 DOM 变动都顺手把被隐藏的分页条恢复
    var b = hideLegacyBars();      // 旧实例若又插了工具条，继续隐藏
    if (!state.applied && state.tries < CFG.maxApplyTries && !a && !b && !state.suppress && !state.busy) {
      schedule(450);
    }
  });
  mo.observe(document.documentElement || document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['style']
  });

  window.addEventListener('hashchange', function () {
    state.applied = false; state.merged = false;   // 切换分标：重置守卫，新明细表重新收集/设置
    state.tries = 0;
    schedule(900);
  });

  var ctrl = {
    version: VERSION,
    destroy: function () {
      state.stopped = true;
      try { mo.disconnect(); } catch (e) {}
      clearTimeout(state.timer);
      if (state.bar && state.bar.wrap && state.bar.wrap.parentNode) {
        state.bar.wrap.parentNode.removeChild(state.bar.wrap);
      }
      restorePagers();
    }
  };
  window[CTRL_KEY] = ctrl;

  schedule(700);
  log('v4 已注入, hash =', location.hash);
})();
