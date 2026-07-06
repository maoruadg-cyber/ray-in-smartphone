// ==UserScript==
// @name         Amazon定期おトク便 全解約ループ
// @namespace    https://github.com/maoruadg-cyber/ray-in-smartphone
// @version      0.2.0
// @description  定期おトク便の管理画面で1回押すと、商品を開く→詳細設定→停止→登録をキャンセル→一覧に戻る、を登録商品がなくなるまで自動でループします。
// @match        https://www.amazon.co.jp/auto-deliveries*
// @match        https://www.amazon.co.jp/gp/subscribe-and-save/*
// @match        https://www.amazon.co.jp/gp/mys/*
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
    // 一覧ページで各商品(定期便)の詳細へ飛ぶリンクを探すセレクタ候補
    itemLinkSelectors: [
      'a[href*="auto-deliveries/subscription"]',
      'a[href*="subscriptionId"]',
      'a[href*="/gp/subscribe-and-save/manager/viewsubscription"]',
    ],
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

  // ---- ユーティリティ ----------------------------------------------------
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  const norm = (s) => (s || '').replace(/\s+/g, '');

  // 文言候補のどれかを含む、クリック可能な要素を探す(ボタン・リンク・input)
  const findClickable = (texts) => {
    const candidates = document.querySelectorAll('button, a, input[type="submit"], [role="button"], .a-button, .a-expander-header');
    for (const text of texts) {
      for (const el of candidates) {
        const label = el.tagName === 'INPUT' ? el.value : el.textContent;
        if (norm(label).includes(norm(text)) && visible(el)) {
          return el.querySelector('input, button') || el;
        }
      }
    }
    return null;
  };

  const findReasonRadio = (texts) => {
    const labels = document.querySelectorAll('label, .a-radio');
    for (const text of texts) {
      for (const el of labels) {
        if ((el.textContent || '').includes(text) && visible(el)) {
          return el.querySelector('input[type="radio"]') || el;
        }
      }
    }
    return [...document.querySelectorAll('input[type="radio"]')].find(visible) || null;
  };

  const findItemLink = () => {
    for (const sel of CONFIG.itemLinkSelectors) {
      const link = [...document.querySelectorAll(sel)].find(visible);
      if (link) return link;
    }
    return null;
  };

  const pageContains = (texts) => {
    const body = document.body.innerText || '';
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

    if (Date.now() - lastProgress > CONFIG.stepTimeoutMs) {
      stop(`⏱ ${CONFIG.stepTimeoutMs / 1000}秒進展がないため中断しました(解約済み ${count} 件)。画面の文言が変わった可能性があります。`, '#b12704');
      return;
    }
    if (count >= CONFIG.maxItems) {
      stop(`🛑 安全上限(${CONFIG.maxItems}件)に達したため停止しました。`, '#b12704');
      return;
    }

    // --- 終了判定: 一覧ページで商品がもう無い ---
    if (onListPage() && (pageContains(CONFIG.emptyTexts) || (!findItemLink() && Date.now() - lastProgress > 3000))) {
      // 一覧の描画待ちを考慮して、3秒リンクが見つからない場合も完了とみなす
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
    const itemLink = onListPage() ? findItemLink() : null;

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
    } else if (itemLink) {
      toast(`[${count + 1}件目] 商品ページを開いています…`);
      progress();
      itemLink.click();
    }
    // どれも見つからない場合は何もせず次のtickへ(描画待ち)。
    // stepTimeoutMsを超えたら冒頭の判定で中断される。

    setTimeout(tick, CONFIG.tickMs);
  };

  // ---- 開始ボタンの設置 -----------------------------------------------------
  const addButton = () => {
    if (document.getElementById('teiki-cancel-btn')) return;
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
