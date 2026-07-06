// ==UserScript==
// @name         Amazon定期おトク便 ワンクリック解約
// @namespace    https://github.com/maoruadg-cyber/ray-in-smartphone
// @version      0.1.0
// @description  定期おトク便のページに「ワンクリック解約」ボタンを追加。押すと解約ボタン→理由選択→最終確認まで自動でクリックして進めます。
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
    // Step1: 解約フローを開くボタン/リンクの文言候補
    openCancelTexts: [
      '定期おトク便の登録をキャンセル',
      '定期おトク便を解約',
      '登録をキャンセルする',
      '解約する',
    ],
    // Step2: 解約理由の選択肢。上から順に探して最初に見つかったものを選ぶ
    reasonTexts: [
      '十分な在庫がある',
      '在庫が余っている',
      'その他',
    ],
    // Step3: 最終確認ボタンの文言候補
    confirmTexts: [
      '定期おトク便の登録をキャンセルする',
      '登録をキャンセルする',
      'キャンセルを確定',
      '解約を確定',
      '解約する',
    ],
    // 解約が完了したと判定する画面上の文言
    doneTexts: [
      'キャンセルされました',
      '解約されました',
      'キャンセルが完了',
    ],
    clickIntervalMs: 700, // 各ステップのクリック間隔
    timeoutMs: 20000,     // これを超えたら自動操作を中断
  };

  const FLAG_KEY = 'teikiCancel.running';

  // ---- ユーティリティ ----------------------------------------------------
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  // 文言候補のどれかを含む、クリック可能な要素を探す(ボタン・リンク・input)
  const findClickable = (texts) => {
    const candidates = document.querySelectorAll('button, a, input[type="submit"], [role="button"], .a-button');
    for (const text of texts) {
      for (const el of candidates) {
        const label = (el.tagName === 'INPUT' ? el.value : el.textContent) || '';
        if (label.replace(/\s+/g, '').includes(text.replace(/\s+/g, '')) && visible(el)) {
          // .a-button ラッパーの場合は中のinput/buttonを優先
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
    // 候補が見つからなければ、表示中の最初のラジオボタンを選ぶ
    return [...document.querySelectorAll('input[type="radio"]')].find(visible) || null;
  };

  const pageContains = (texts) => {
    const body = document.body.innerText || '';
    return texts.some((t) => body.includes(t));
  };

  // ---- 進捗トースト --------------------------------------------------------
  const toast = (msg, color = '#232f3e') => {
    let el = document.getElementById('teiki-cancel-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'teiki-cancel-toast';
      el.style.cssText =
        'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:99999;' +
        'padding:10px 18px;border-radius:8px;color:#fff;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.3);';
      document.body.appendChild(el);
    }
    el.style.background = color;
    el.textContent = msg;
  };

  // ---- 自動解約の本体 ------------------------------------------------------
  // ページ遷移をまたいで動けるよう、実行中フラグはsessionStorageに持つ
  const startAutoCancel = () => {
    sessionStorage.setItem(FLAG_KEY, String(Date.now()));
    runLoop();
  };

  const stopAutoCancel = (msg, color) => {
    sessionStorage.removeItem(FLAG_KEY);
    if (msg) toast(msg, color);
  };

  const runLoop = () => {
    const startedAt = Number(sessionStorage.getItem(FLAG_KEY));
    if (!startedAt) return;

    if (Date.now() - startedAt > CONFIG.timeoutMs) {
      stopAutoCancel('⏱ タイムアウトしました。画面の文言が変わった可能性があります。', '#b12704');
      return;
    }

    if (pageContains(CONFIG.doneTexts)) {
      stopAutoCancel('✅ 解約が完了しました', '#067d62');
      return;
    }

    // 後ろのステップから順に判定する(確認ダイアログが出ていればそれを最優先)
    const confirmBtn = findClickable(CONFIG.confirmTexts);
    const reasonRadio = findReasonRadio(CONFIG.reasonTexts);
    const openBtn = findClickable(CONFIG.openCancelTexts);

    if (confirmBtn && reasonRadio && !reasonRadio.checked) {
      toast('② 解約理由を選択中…');
      reasonRadio.click();
    } else if (confirmBtn) {
      toast('③ 最終確認をクリック…');
      confirmBtn.click();
    } else if (openBtn) {
      toast('① 解約フローを開いています…');
      openBtn.click();
    }

    setTimeout(runLoop, CONFIG.clickIntervalMs);
  };

  // ---- ワンクリックボタンの設置 --------------------------------------------
  const addButton = () => {
    if (document.getElementById('teiki-cancel-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'teiki-cancel-btn';
    btn.textContent = '⚡ ワンクリック解約';
    btn.style.cssText =
      'position:fixed;bottom:20px;right:20px;z-index:99999;padding:12px 20px;' +
      'background:#ff9900;color:#111;border:none;border-radius:24px;font-size:15px;' +
      'font-weight:bold;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;';
    btn.addEventListener('click', () => {
      if (!confirm('この商品の定期おトク便を解約します。よろしいですか?\n(解約したい商品の詳細を開いた状態で実行してください)')) return;
      startAutoCancel();
    });
    document.body.appendChild(btn);
  };

  addButton();
  // SPA遷移でボタンが消えた場合に備えて監視
  new MutationObserver(addButton).observe(document.body, { childList: true });
  // ページ遷移直後に実行中フラグが残っていれば続きから再開
  if (sessionStorage.getItem(FLAG_KEY)) runLoop();
})();
