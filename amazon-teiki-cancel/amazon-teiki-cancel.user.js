// ==UserScript==
// @name         Amazon定期おトク便 全解約ループ
// @namespace    https://github.com/maoruadg-cyber/ray-in-smartphone
// @version      0.4.0
// @description  定期おトク便の管理画面で1回押すと、商品を開く→詳細設定→停止→登録をキャンセル→一覧に戻る、を登録商品がなくなるまで自動でループします。
// @match        https://www.amazon.co.jp/*
// @match        https://amazon.co.jp/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // ---- 設定 --------------------------------------------------------------
  // AmazonのUI文言が変わったら、ここの候補リストに文言を足すだけで直せます。
  const CONFIG = {
    // 定期おトク便の管理(一覧)ページ
    listUrl: 'https://www.amazon.co.jp/auto-deliveries',
    // 一覧ページで各商品(定期便)の詳細へ飛ぶリンクのhrefパターン
    // ※「auto-deliveries/」を含めるとナビの「定期おトク便(landing)」「設定(preferences)」を
    //   誤クリックするので入れないこと(v0.3.0の不具合)
    itemLinkPattern: /subscriptionId=|viewsubscription/i,
    // サブスクリプションカードを見つける目印の文言(カード内に必ず表示される)
    cardMarkerText: '次回のお届け日',
    // 「商品の詳細設定」を開くボタン/リンクの文言候補
    detailSettingsTexts: ['商品の詳細設定', '詳細設定', '定期おトク便の設定'],
    // 「定期おトク便を停止する」ボタンの文言候補
    stopTexts: ['定期おトク便を停止する', '定期おトク便を停止', '登録をキャンセルする', '定期おトク便の登録をキャンセル'],
    // 停止理由の選択肢。上から順に探して最初に見つかったものを選ぶ
    reasonTexts: ['十分な在庫がある', '在庫が余っている', 'その他'],
    // 最終確認「登録をキャンセル」ボタンの文言候補
    confirmTexts: ['登録をキャンセル', 'キャンセルを確定', '解約を確定'],
    // 解約が完了したと判定する文言
    cancelledTexts: ['キャンセルされました', '解約されました', 'キャンセルが完了'],
    // 登録商品がゼロになったと判定する文言
    emptyTexts: ['登録されている商品はありません', '定期おトク便の登録はありません', '現在、定期おトク便はありません'],
    tickMs: 800,          // 状態チェックの間隔
    stepTimeoutMs: 20000, // 何も進展がないままこの時間が経ったら中断
    maxItems: 100,        // 安全のための解約上限
  };

  const KEY = {
    running: 'teikiCancel.running',       // ループ実行中フラグ
    lastProgress: 'teikiCancel.progress', // 最後に操作できた時刻
    cancelled: 'teikiCancel.count',       // 解約済み件数
  };

  // ---- DOM探索ユーティリティ ----------------------------------------------
  // AmazonはShadow DOMを使うことがあるため、shadowRootの中まで再帰的に探索する
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

  const norm = (s) => (s || '').replace(/\s+/g, '');

  const isClickableTag = (el) =>
    /^(BUTTON|A)$/.test(el.tagName) ||
    (el.tagName === 'INPUT' && /submit|button/.test(el.type)) ||
    el.getAttribute('role') === 'button' ||
    el.classList.contains('a-button') ||
    el.classList.contains('a-expander-header');

  // 文言候補のどれかを含む、クリック可能な要素を探す
  const findClickable = (texts) => {
    const candidates = allElements().filter((el) => isClickableTag(el) && visible(el));
    for (const text of texts) {
      for (const el of candidates) {
        const label = el.tagName === 'INPUT' ? el.value : el.textContent;
        if (norm(label).includes(norm(text))) {
          return el.querySelector('input, button') || el;
        }
      }
    }
    return null;
  };

  const findReasonRadio = (texts) => {
    const els = allElements();
    const labels = els.filter((el) => (el.tagName === 'LABEL' || el.classList.contains('a-radio')) && visible(el));
    for (const text of texts) {
      for (const el of labels) {
        if ((el.textContent || '').includes(text)) {
          return el.querySelector('input[type="radio"]') || el;
        }
      }
    }
    return els.find((el) => el.tagName === 'INPUT' && el.type === 'radio' && visible(el)) || null;
  };

  const findItemLink = () =>
    allElements().find(
      (el) => el.tagName === 'A' && CONFIG.itemLinkPattern.test(el.href || '') && visible(el)
    ) || null;

  // 「ご利用のサブスクリプション」の商品カードを探す。
  // カードはAタグではなくJSのクリックハンドラで動くため、カード内に必ず表示される
  // 「次回のお届け日」の文言を目印に見つけて、クリック可能な祖先要素ごとクリックする。
  const findSubscriptionCard = () => {
    const withMarker = allElements().filter(
      (el) => visible(el) && (el.textContent || '').includes(CONFIG.cardMarkerText)
    );
    if (!withMarker.length) return null;
    // 文言を含む一番内側(テキストが最短)の要素 = カード内の日付行
    const base = withMarker.sort(
      (a, b) => (a.textContent || '').length - (b.textContent || '').length
    )[0];
    // そこから遡って、クリックハンドラを持っていそうな一番外側の祖先(=カード全体)を探す
    let clickTarget = base;
    let cur = base;
    for (let i = 0; i < 12 && cur && cur !== document.body; i++) {
      const role = cur.getAttribute && cur.getAttribute('role');
      if (
        getComputedStyle(cur).cursor === 'pointer' ||
        role === 'link' || role === 'button' ||
        cur.hasAttribute('tabindex') || cur.onclick || cur.tagName === 'A'
      ) {
        clickTarget = cur;
      }
      cur = cur.parentElement;
    }
    return clickTarget;
  };

  // Reactなどで作られたカードは .click() に反応しないことがあるため、
  // 実際のマウス操作と同じイベント列を発火させる
  const fireClick = (el) => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  };

  const pageText = () => {
    let t = document.body.innerText || '';
    for (const el of allElements()) if (el.shadowRoot) t += '\n' + (el.shadowRoot.textContent || '');
    return t;
  };

  const pageContains = (texts) => {
    const body = pageText();
    return texts.some((t) => body.includes(t));
  };

  const onListPage = () =>
    location.href.startsWith(CONFIG.listUrl) && !/subscription/i.test(location.href);

  // ---- 進捗トースト --------------------------------------------------------
  const toast = (msg, color = '#232f3e') => {
    let el = document.getElementById('teiki-cancel-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'teiki-cancel-toast';
      el.style.cssText =
        'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:99999;' +
        'padding:10px 18px;border-radius:8px;color:#fff;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.3);' +
        'max-width:90%;text-align:center;';
      document.body.appendChild(el);
    }
    el.style.background = color;
    el.textContent = msg;
  };

  // ---- ループ本体 ----------------------------------------------------------
  // ページ遷移をまたいで動けるよう、状態はすべてsessionStorageに持つ。
  // 毎tick「いま画面に何が見えているか」で次の一手を決める方式なので、
  // どのページから始めても途中参加できる。
  const progress = () => sessionStorage.setItem(KEY.lastProgress, String(Date.now()));

  const start = () => {
    sessionStorage.setItem(KEY.running, '1');
    sessionStorage.setItem(KEY.cancelled, '0');
    progress();
    tick();
  };

  const stop = (msg, color) => {
    sessionStorage.removeItem(KEY.running);
    sessionStorage.removeItem(KEY.lastProgress);
    if (msg) toast(msg, color);
  };

  const tick = () => {
    if (!sessionStorage.getItem(KEY.running)) return;

    const count = Number(sessionStorage.getItem(KEY.cancelled) || 0);
    const lastProgress = Number(sessionStorage.getItem(KEY.lastProgress) || 0);
    const stalledMs = Date.now() - lastProgress;

    if (stalledMs > CONFIG.stepTimeoutMs) {
      stop(`⏱ ${CONFIG.stepTimeoutMs / 1000}秒進展がないため中断しました(解約済み ${count} 件)。「🔍診断」の結果を開発者に送ってください。`, '#b12704');
      return;
    }
    if (count >= CONFIG.maxItems) {
      stop(`🛑 安全上限(${CONFIG.maxItems}件)に達したため停止しました。`, '#b12704');
      return;
    }

    // --- 終了判定 ---
    // 「登録商品なし」の文言を検知したときだけ完了扱いにする。
    // 商品リンクが見つからないだけの場合は、探し方が実際のページ構造と
    // 合っていない可能性があるため、完了ではなくエラーとして停止する。
    if (onListPage() && pageContains(CONFIG.emptyTexts)) {
      stop(`✅ 完了！ ${count} 件すべて解約しました。`, '#067d62');
      return;
    }

    // --- 解約完了画面 → 件数を数えて一覧へ戻る ---
    if (pageContains(CONFIG.cancelledTexts)) {
      sessionStorage.setItem(KEY.cancelled, String(count + 1));
      progress();
      toast(`✔ ${count + 1} 件目を解約。一覧に戻ります…`, '#067d62');
      setTimeout(() => (location.href = CONFIG.listUrl), 1000);
      return;
    }

    // --- 深いステップから順に判定(確認ダイアログが出ていれば最優先) ---
    const confirmBtn = findClickable(CONFIG.confirmTexts);
    const reasonRadio = findReasonRadio(CONFIG.reasonTexts);
    const stopBtn = findClickable(CONFIG.stopTexts);
    const settingsBtn = findClickable(CONFIG.detailSettingsTexts);
    const itemEl = onListPage() ? findItemLink() || findSubscriptionCard() : null;

    if (confirmBtn && reasonRadio && !reasonRadio.checked) {
      toast(`[${count + 1}件目] 理由を選択中…`);
      reasonRadio.click();
      progress();
    } else if (confirmBtn) {
      toast(`[${count + 1}件目] 「登録をキャンセル」をクリック…`);
      confirmBtn.click();
      progress();
    } else if (stopBtn) {
      toast(`[${count + 1}件目] 「定期おトク便を停止する」をクリック…`);
      stopBtn.click();
      progress();
    } else if (settingsBtn) {
      toast(`[${count + 1}件目] 商品の詳細設定を開いています…`);
      settingsBtn.click();
      progress();
    } else if (itemEl) {
      toast(`[${count + 1}件目] 商品を開いています…`);
      progress();
      fireClick(itemEl);
    } else if (onListPage() && stalledMs > 6000) {
      // 一覧ページで6秒以上なにも見つからない: ページ構造が想定と違う
      stop('⚠ 操作対象が見つかりません。「🔍診断」ボタンを押して、結果を開発者に送ってください。', '#b12704');
      return;
    }
    // どれも見つからない場合は何もせず次のtickへ(描画待ち)

    setTimeout(tick, CONFIG.tickMs);
  };

  // ---- 診断モード -----------------------------------------------------------
  // ページ上のクリック可能要素を一覧にして表示する。
  // スクリプトがボタンを見つけられないとき、この結果を見れば
  // CONFIGの文言リストをどう直せばいいか分かる。
  const runDiagnostic = () => {
    const lines = [
      `URL: ${location.href}`,
      `title: ${document.title}`,
      `iframes: ${document.querySelectorAll('iframe').length}`,
      '--- クリック可能要素 (tag | text | href) ---',
    ];
    const seen = new Set();
    for (const el of allElements()) {
      if (!isClickableTag(el) || !visible(el)) continue;
      const text = (el.tagName === 'INPUT' ? el.value : el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50);
      const href = (el.href || '').slice(0, 120);
      const line = `${el.tagName} | ${text} | ${href}`;
      if (!text && !href) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      if (lines.length > 300) break;
    }
    // サブスクリプションカードの構造(カードクリックが効かないときの修正用)
    const marker = allElements()
      .filter((el) => visible(el) && (el.textContent || '').includes(CONFIG.cardMarkerText))
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
    if (marker) {
      lines.push(`--- 「${CONFIG.cardMarkerText}」を含むカードの祖先チェーン ---`);
      let cur = marker;
      for (let i = 0; i < 10 && cur && cur !== document.body; i++) {
        const role = cur.getAttribute ? cur.getAttribute('role') : null;
        lines.push(
          `${i}: ${cur.tagName}` +
          (cur.className ? ` class="${String(cur.className).slice(0, 80)}"` : '') +
          (role ? ` role=${role}` : '') +
          (cur.hasAttribute('tabindex') ? ' tabindex' : '') +
          ` cursor=${getComputedStyle(cur).cursor}`
        );
        cur = cur.parentElement;
      }
      const card = findSubscriptionCard();
      if (card) {
        lines.push('--- クリック対象に選ばれた要素のHTML(先頭1500文字) ---');
        lines.push(card.outerHTML.slice(0, 1500));
      }
    } else {
      lines.push(`(「${CONFIG.cardMarkerText}」を含む要素は見つかりませんでした)`);
    }
    const overlay = document.createElement('div');
    overlay.id = 'teiki-diag-overlay';
    overlay.style.cssText =
      'position:fixed;inset:5% 5%;z-index:100000;background:#fff;border:2px solid #232f3e;' +
      'border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 24px rgba(0,0,0,.4);';
    const ta = document.createElement('textarea');
    ta.value = lines.join('\n');
    ta.style.cssText = 'flex:1;width:100%;font-size:11px;font-family:monospace;';
    const bar = document.createElement('div');
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 全部コピー';
    copyBtn.style.cssText = 'padding:8px 16px;margin-right:8px;cursor:pointer;';
    copyBtn.onclick = () => {
      ta.select();
      navigator.clipboard.writeText(ta.value).then(() => (copyBtn.textContent = '✅ コピーしました'));
    };
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '閉じる';
    closeBtn.style.cssText = 'padding:8px 16px;cursor:pointer;';
    closeBtn.onclick = () => overlay.remove();
    bar.append(copyBtn, closeBtn);
    overlay.append(ta, bar);
    document.body.appendChild(overlay);
  };

  // ---- ボタンの設置 -----------------------------------------------------
  // Amazon全ページで動かしつつ、定期おトク便関連の画面でだけボタンを表示する
  const isTeikiPage = () =>
    /auto-deliveries|subscribe-and-save|teiki|mys/i.test(location.href) ||
    (document.title || '').includes('定期おトク便') ||
    sessionStorage.getItem(KEY.running); // ループ実行中はどの画面でも表示(停止ボタンとして)

  const addButton = () => {
    const existing = document.getElementById('teiki-cancel-btn');
    if (!isTeikiPage()) {
      if (existing) existing.remove();
      const diag = document.getElementById('teiki-diag-btn');
      if (diag) diag.remove();
      return;
    }
    if (existing) return;

    const btn = document.createElement('button');
    btn.id = 'teiki-cancel-btn';
    btn.textContent = '⚡ 定期便を全部解約';
    btn.style.cssText =
      'position:fixed;bottom:20px;right:20px;z-index:99999;padding:12px 20px;' +
      'background:#ff9900;color:#111;border:none;border-radius:24px;font-size:15px;' +
      'font-weight:bold;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;';
    btn.addEventListener('click', () => {
      if (sessionStorage.getItem(KEY.running)) {
        stop('⏹ 停止しました。', '#b12704');
        return;
      }
      if (!confirm('定期おトク便に登録されている商品を、なくなるまで順番にすべて解約します。\nよろしいですか?\n\n(実行中にもう一度ボタンを押すと停止します)')) return;
      start();
    });
    document.body.appendChild(btn);

    const diagBtn = document.createElement('button');
    diagBtn.id = 'teiki-diag-btn';
    diagBtn.textContent = '🔍 診断';
    diagBtn.style.cssText =
      'position:fixed;bottom:20px;right:200px;z-index:99999;padding:12px 16px;' +
      'background:#232f3e;color:#fff;border:none;border-radius:24px;font-size:13px;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;';
    diagBtn.addEventListener('click', runDiagnostic);
    document.body.appendChild(diagBtn);
  };

  addButton();
  // SPA遷移でボタンが消えた場合に備えて監視
  new MutationObserver(addButton).observe(document.body, { childList: true });
  // ページ遷移直後に実行中フラグが残っていれば続きから再開
  if (sessionStorage.getItem(KEY.running)) {
    progress(); // ページ読み込み自体を進展とみなす
    tick();
  }
})();
