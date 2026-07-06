// ==UserScript==
// @name         ページ診断ツール (Page Inspector)
// @namespace    https://github.com/maoruadg-cyber/ray-in-smartphone
// @version      0.1.0
// @description  どのサイトでも右下の🔍ボタンから、ページ上のクリック可能要素・入力欄の一覧や、選んだ要素のHTML構造をコピーできる診断ツール。自動化スクリプト作成の下調べ用。
// @match        http://*/*
// @match        https://*/*
// @noframes
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const LIMIT = { clickables: 250, fields: 100, html: 3000 };

  // ---- DOM探索(shadowRootの中まで再帰) --------------------------------------
  const allElements = () => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  };

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  const isClickable = (el) =>
    /^(BUTTON|A)$/.test(el.tagName) ||
    (el.tagName === 'INPUT' && /submit|button/.test(el.type)) ||
    ['button', 'link', 'menuitem', 'tab'].includes(el.getAttribute('role') || '');

  const isField = (el) =>
    (el.tagName === 'INPUT' && !/submit|button|hidden/.test(el.type)) ||
    el.tagName === 'SELECT' ||
    el.tagName === 'TEXTAREA' ||
    el.isContentEditable;

  // ---- レポート生成 ----------------------------------------------------------
  const pageReport = () => {
    const lines = [
      `URL: ${location.href}`,
      `title: ${document.title}`,
      `iframes: ${document.querySelectorAll('iframe').length}`,
      '',
      '=== クリック可能要素 (tag | text | href) ===',
    ];
    const seen = new Set();
    let clickables = 0;
    let fields = 0;
    const fieldLines = [];
    for (const el of allElements()) {
      if (!visible(el)) continue;
      if (isClickable(el) && clickables < LIMIT.clickables) {
        const text = (el.tagName === 'INPUT' ? el.value : el.textContent || '')
          .trim().replace(/\s+/g, ' ').slice(0, 50);
        const href = (el.href || '').slice(0, 120);
        const line = `${el.tagName} | ${text} | ${href}`;
        if ((text || href) && !seen.has(line)) {
          seen.add(line);
          lines.push(line);
          clickables++;
        }
      } else if (isField(el) && fields < LIMIT.fields) {
        const parts = [
          el.tagName,
          el.type ? `type=${el.type}` : '',
          el.name ? `name=${el.name}` : '',
          el.id ? `id=${el.id}` : '',
          el.placeholder ? `placeholder=${el.placeholder}` : '',
        ].filter(Boolean).join(' ');
        if (!seen.has(parts)) {
          seen.add(parts);
          fieldLines.push(parts);
          fields++;
        }
      }
    }
    lines.push('', '=== 入力欄 ===', ...fieldLines);
    if (clickables >= LIMIT.clickables) lines.push(`(クリック可能要素が多いため${LIMIT.clickables}件で打ち切り)`);
    return lines.join('\n');
  };

  const elementReport = (el) => {
    const lines = [
      `URL: ${location.href}`,
      '=== 選択した要素の祖先チェーン (内側→外側) ===',
    ];
    let cur = el;
    for (let i = 0; i < 15 && cur && cur !== document.documentElement; i++) {
      const role = cur.getAttribute ? cur.getAttribute('role') : null;
      lines.push(
        `${i}: ${cur.tagName}` +
        (cur.id ? ` id="${cur.id}"` : '') +
        (cur.className && typeof cur.className === 'string' ? ` class="${cur.className.slice(0, 80)}"` : '') +
        (role ? ` role=${role}` : '') +
        (cur.hasAttribute('tabindex') ? ' tabindex' : '') +
        ` cursor=${getComputedStyle(cur).cursor}`
      );
      cur = cur.parentElement;
    }
    lines.push('', `=== 選択した要素のHTML (先頭${LIMIT.html}文字) ===`, el.outerHTML.slice(0, LIMIT.html));
    return lines.join('\n');
  };

  // ---- オーバーレイUI --------------------------------------------------------
  const showOverlay = (text) => {
    document.getElementById('pgi-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'pgi-overlay';
    overlay.style.cssText =
      'position:fixed;inset:5% 5%;z-index:2147483646;background:#fff;color:#111;border:2px solid #333;' +
      'border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 24px rgba(0,0,0,.4);';
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'flex:1;width:100%;font-size:11px;font-family:monospace;color:#111;background:#fff;';
    const bar = document.createElement('div');
    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'padding:8px 16px;margin-right:8px;cursor:pointer;';
      b.onclick = fn;
      return b;
    };
    const copyBtn = mkBtn('📋 全部コピー', () => {
      ta.select();
      navigator.clipboard.writeText(ta.value).then(() => (copyBtn.textContent = '✅ コピーしました'));
    });
    bar.append(
      copyBtn,
      mkBtn('🎯 要素を調べる', () => { overlay.remove(); startPick(); }),
      mkBtn('閉じる', () => overlay.remove()),
    );
    overlay.append(ta, bar);
    document.body.appendChild(overlay);
  };

  // ---- 要素ピッカー ----------------------------------------------------------
  // 「🎯 要素を調べる」→ ページ上の調べたい場所をクリックすると、
  // その要素の構造レポートを表示する(クリック先への遷移は起きない)
  let picking = false;
  let hovered = null;
  let hoveredOutline = '';

  const hint = (msg) => {
    let el = document.getElementById('pgi-hint');
    if (!msg) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'pgi-hint';
      el.style.cssText =
        'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'padding:8px 16px;border-radius:8px;background:#c60;color:#fff;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.3);';
      document.body.appendChild(el);
    }
    el.textContent = msg;
  };

  const onHover = (e) => {
    if (hovered) hovered.style.outline = hoveredOutline;
    hovered = e.target;
    hoveredOutline = hovered.style.outline;
    hovered.style.outline = '2px solid #c60';
  };

  const stopPick = () => {
    picking = false;
    if (hovered) hovered.style.outline = hoveredOutline;
    hovered = null;
    hint(null);
    document.removeEventListener('mouseover', onHover, true);
    document.removeEventListener('click', onPick, true);
    document.removeEventListener('keydown', onKey, true);
  };

  const onPick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.target;
    stopPick();
    showOverlay(elementReport(target));
  };

  const onKey = (e) => {
    if (e.key === 'Escape') stopPick();
  };

  const startPick = () => {
    if (picking) return;
    picking = true;
    hint('調べたい要素をクリックしてください (Escで中止)');
    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('click', onPick, true);
    document.addEventListener('keydown', onKey, true);
  };

  // ---- 常駐ボタン ------------------------------------------------------------
  const addButton = () => {
    if (document.getElementById('pgi-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'pgi-btn';
    btn.textContent = '🔍';
    btn.title = 'ページ診断 (クリック可能要素の一覧を表示)';
    btn.style.cssText =
      'position:fixed;bottom:70px;right:12px;z-index:2147483645;width:36px;height:36px;' +
      'border-radius:50%;border:none;background:#333;color:#fff;font-size:16px;opacity:.5;' +
      'cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3);';
    btn.onmouseenter = () => (btn.style.opacity = '1');
    btn.onmouseleave = () => (btn.style.opacity = '.5');
    btn.onclick = () => showOverlay(pageReport());
    document.body.appendChild(btn);
  };

  addButton();
  new MutationObserver(addButton).observe(document.body, { childList: true });
})();
