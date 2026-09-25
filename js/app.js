// ============================================================
// app.js — UI描画 / 学習パネル / 統計 / クイズ / ゲーム進行
// ============================================================
"use strict";

const $ = (sel) => document.querySelector(sel);
const AI_ORDER = ["tight", "maniac", "loose"]; // 人数に応じてこの順で追加

// 予期しないエラーを確実に記録する(タイマー内の例外は通常見えないため)
window.__errors = [];
window.addEventListener("error", (e) => {
  const msg = `${e.message} @${e.filename}:${e.lineno}:${e.colno}\n${e.error && e.error.stack}`;
  window.__errors.push(msg);
  console.error("[AIポーカー] 未捕捉エラー:", msg);
});

// ------------------------------------------------------------
// 統計(localStorage)
// ------------------------------------------------------------
const STATS_KEY = "aipoker_stats_v1";
const defaultStats = () => ({
  hands: 0, handsWon: 0, showdowns: 0, showdownsWon: 0,
  vpipHands: 0, invested: 0, returned: 0,
  bankrollHistory: [0],
  predictions: 0, predictionsCorrect: 0,
  eqQuiz: 0, eqQuizCorrect: 0,
  rankQuiz: 0, rankQuizCorrect: 0,
});
let stats = loadStats();
function loadStats() {
  try {
    const s = JSON.parse(localStorage.getItem(STATS_KEY));
    return s ? Object.assign(defaultStats(), s) : defaultStats();
  } catch (e) { return defaultStats(); }
}
function saveStats() { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); }
function roi() {
  return stats.invested > 0 ? (stats.returned / stats.invested) * 100 : null;
}

// ------------------------------------------------------------
// ゲームのセットアップと進行
// ------------------------------------------------------------
let game = null;
let handState = null; // 1ハンド中の一時情報

function newGame() {
  if (handState && handState.aiTimer) clearTimeout(handState.aiTimer);
  if (game) { game.onEvent = () => {}; game.onBeforeShowdown = null; } // 旧ゲームを切り離す
  const count = parseInt($("#ai-count").value, 10);
  const aiKeys = AI_ORDER.slice(0, count);
  game = new Game({ aiKeys, onEvent: handleEvent });
  game.onBeforeShowdown = beforeShowdownChallenge;
  $("#log").innerHTML = "";
  $("#ai-roster").textContent = aiKeys
    .map((k) => `${PERSONALITIES[k].name}(${PERSONALITIES[k].label})`)
    .join(" / ");
  startNextHand();
}

function startNextHand() {
  if (handState && handState.aiTimer) clearTimeout(handState.aiTimer);
  handState = {
    heroInvested: 0, heroReturned: 0, vpip: false,
    revealed: false, aiTimer: null, cachedEquity: null,
  };
  game.startHand();
  renderAll();
  proceed();
}

let lastActivity = Date.now();

function handleEvent(ev) {
  if (!game) return;
  lastActivity = Date.now();
  try {
    handleEventInner(ev);
  } catch (err) {
    // 描画の例外がゲーム進行(エンジン)を止めないように隔離する
    window.__errors.push(`イベント処理例外(${ev.type}): ${err.message}\n${err.stack}`);
    console.error("[AIポーカー] イベント処理例外:", ev.type, err.message, err.stack);
  }
}

function handleEventInner(ev) {
  switch (ev.type) {
    case "log":
      appendLog(ev.text, ev.cls);
      break;
    case "heroInvest":
      handState.heroInvested += ev.amount;
      break;
    case "heroReturn":
      handState.heroReturned += ev.amount;
      break;
    case "action":
      if (ev.player.isHero && game.street === "preflop" &&
          (ev.action.type === "call" || ev.action.type === "raise")) {
        handState.vpip = true;
      }
      ev.player.lastActionText = actionText(ev.action, ev.player);
      renderAll();
      break;
    case "street":
      game.players.forEach((p) => (p.lastActionText = null));
      handState.cachedEquity = null;
      renderAll();
      break;
    case "handStart":
      renderAll();
      break;
    case "handEnd":
      onHandEnd(ev);
      break;
    case "turnChange":
    case "runout":
      renderAll();
      break;
  }
}

function actionText(action, player) {
  switch (action.type) {
    case "fold": return "フォールド";
    case "check": return "チェック";
    case "call": return player.allin ? "コール(オールイン)" : "コール";
    case "raise": return (player.allin ? "オールイン " : (action.verbUsed || "レイズ") + " ") + player.streetBet;
    default: return "";
  }
}

function proceed() {
  if (!game || game.handOver) { renderAll(); return; }
  const cp = game.currentPlayer();
  if (!cp) { renderAll(); return; } // ランアウト中
  if (cp.isHero) { renderAll(); return; } // ボタン待ち
  // AIの手番(タイマー発火時にゲームが切り替わっていたら何もしない)
  renderAll();
  const g = game;
  handState.aiTimer = setTimeout(() => {
    if (g !== game || g.handOver) return;
    const cur = g.currentPlayer();
    if (!cur || cur.isHero) return;
    try {
      const action = aiDecide(cur, g);
      g.applyAction(cur, action);
    } catch (err) {
      // 例外で進行が止まらないように記録して復帰する
      window.__errors.push(`AIターン例外: ${err.message}\n${err.stack}`);
      console.error("[AIポーカー] AIターン例外:", err.message, err.stack);
      if (g === game && !g.handOver && g.currentPlayer() === cur) {
        const toCall = g.currentBet - cur.streetBet;
        g.applyAction(cur, { type: toCall > 0 ? "call" : "check" });
      }
    }
    proceed();
  }, window.AI_DELAY_MS || 700 + Math.random() * 700);
}

function heroAct(action) {
  const cp = game.currentPlayer();
  if (!cp || !cp.isHero || game.handOver) return;
  game.applyAction(cp, action);
  proceed();
}

// ------------------------------------------------------------
// ハンド終了処理と統計
// ------------------------------------------------------------
function onHandEnd(ev) {
  const wasShowdown = ev.results.some((r) => r.reveal);
  if (wasShowdown) handState.revealed = true;

  stats.hands++;
  if (handState.vpip) stats.vpipHands++;
  stats.invested += handState.heroInvested;
  stats.returned += handState.heroReturned;
  const heroInShowdown = wasShowdown && !game.hero().folded;
  if (heroInShowdown) {
    stats.showdowns++;
    if (ev.results.some((r) => r.player.isHero)) stats.showdownsWon++;
  }
  if (handState.heroReturned > 0) stats.handsWon++;
  const prev = stats.bankrollHistory[stats.bankrollHistory.length - 1] || 0;
  stats.bankrollHistory.push(prev + handState.heroReturned - handState.heroInvested);
  if (stats.bankrollHistory.length > 500) stats.bankrollHistory.shift();
  saveStats();
  renderAll();
  renderStatsTab();
}

// ------------------------------------------------------------
// ショーダウン前のハンド読みチャレンジ
// ------------------------------------------------------------
function beforeShowdownChallenge(continueFn) {
  const hero = game.hero();
  const aiActive = game.activePlayers().filter((p) => !p.isHero);
  if (hero.folded || aiActive.length === 0) { continueFn(); return; }

  let target = aiActive[0];
  if (game.lastAggressor && !game.lastAggressor.isHero &&
      !game.lastAggressor.folded) target = game.lastAggressor;

  const actual = comboStrength(target.hole, game.board); // strong | mid | weak (riverではdrawなし)
  const options = [
    { key: "strong", label: "強い(トップペア以上)", desc: "トップペア・オーバーペア・ツーペア以上" },
    { key: "mid", label: "ミドル(弱いペア)", desc: "セカンドペア以下のワンペア" },
    { key: "weak", label: "ノーメイド(ブラフ気味)", desc: "ハイカードやドロー崩れ" },
  ];
  const answerKey = actual === "draw" ? "weak" : actual;

  showModal(`
    <h3>🔍 ハンド読みチャレンジ</h3>
    <p><b>${target.name}</b>(${target.personality.label})のハンドはどのくらいの強さ?</p>
    <p class="modal-sub">ボード: ${game.board.map(cardStr).join(" ")} / これまでのアクションから推理しよう</p>
    <div class="modal-options">
      ${options.map((o) => `<button class="modal-opt" data-key="${o.key}">${o.label}<small>${o.desc}</small></button>`).join("")}
    </div>
    <button class="modal-skip" data-key="__skip">スキップ</button>
  `);
  document.querySelectorAll("#modal-box [data-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      hideModal();
      if (key !== "__skip") {
        stats.predictions++;
        const correct = key === answerKey;
        if (correct) stats.predictionsCorrect++;
        saveStats();
        const labelOf = (k) => options.find((o) => o.key === k).label;
        appendLog(
          correct
            ? `読みチャレンジ: 正解! ${target.name}は「${labelOf(answerKey)}」でした`
            : `読みチャレンジ: 残念、${target.name}は「${labelOf(answerKey)}」でした(あなたの予想: ${labelOf(key)})`,
          correct ? "win" : "fold"
        );
      }
      continueFn();
      renderAll();
    });
  });
}

function showModal(html) {
  $("#modal-box").innerHTML = html;
  $("#modal-overlay").classList.remove("hidden");
}
function hideModal() { $("#modal-overlay").classList.add("hidden"); }

// ------------------------------------------------------------
// 描画
// ------------------------------------------------------------
function cardEl(card, faceDown) {
  if (faceDown) return `<div class="card back"></div>`;
  const r = RANKS[cardRank(card)];
  const rankTxt = RANK_JP[r] || r;
  const suit = SUITS[cardSuit(card)];
  const red = suit === "h" || suit === "d" ? " red" : "";
  return `<div class="card${red}"><span class="c-rank">${rankTxt}</span><span class="c-suit">${SUIT_CHARS[suit]}</span></div>`;
}

function renderAll() {
  if (!game) return;
  renderOpponents();
  renderBoard();
  renderHero();
  renderActions();
  renderStudy();
  renderQuickStats();
}

function playerBadges(p) {
  const badges = [];
  if (game.players[game.button] === p) badges.push('<span class="badge btn-badge">D</span>');
  if (game.players[game.sbIdx] === p) badges.push('<span class="badge">SB</span>');
  if (game.players[game.bbIdx] === p) badges.push('<span class="badge">BB</span>');
  return badges.join("");
}

function renderOpponents() {
  const container = $("#opponents");
  container.innerHTML = game.players
    .filter((p) => !p.isHero)
    .map((p) => {
      const showCards = handState.revealed && !p.folded && game.handOver;
      const cards = p.folded
        ? '<div class="card ghost"></div><div class="card ghost"></div>'
        : showCards
          ? p.hole.map((c) => cardEl(c)).join("")
          : cardEl(null, true) + cardEl(null, true);
      const active = game.currentPlayer() === p ? " acting" : "";
      const folded = p.folded ? " folded-p" : "";
      return `
      <div class="player-pod${active}${folded}">
        <div class="pod-cards">${cards}</div>
        <div class="pod-name">${p.name} ${playerBadges(p)}</div>
        <div class="pod-type">${p.personality.label}</div>
        <div class="pod-stack">💰 ${p.stack}</div>
        ${p.streetBet > 0 ? `<div class="pod-bet">ベット: ${p.streetBet}</div>` : ""}
        ${p.lastActionText ? `<div class="pod-action">${p.lastActionText}</div>` : ""}
      </div>`;
    })
    .join("");
}

function renderBoard() {
  $("#street-label").textContent = game.handOver
    ? `ハンド #${game.handNumber} 終了`
    : STREET_JP[game.street] || "";
  $("#board").innerHTML =
    game.board.map((c) => cardEl(c)).join("") +
    Array(5 - game.board.length).fill('<div class="card ghost"></div>').join("");
  $("#pot").textContent = `ポット: ${game.totalPot()}`;
}

function renderHero() {
  const hero = game.hero();
  const active = game.currentPlayer() === hero ? " acting" : "";
  const folded = hero.folded && !game.handOver ? " folded-p" : "";
  const chen = hero.hole.length ? chenScore(hero.hole) : null;
  $("#hero-row").innerHTML = `
    <div class="player-pod hero-pod${active}${folded}">
      <div class="pod-cards big">${hero.hole.map((c) => cardEl(c)).join("")}</div>
      <div class="pod-name">${hero.name} ${playerBadges(hero)}
        ${chen !== null ? `<span class="chen" title="Chenフォーミュラによるプリフロップハンド強度(最高20)">${handLabel(hero.hole)} / チェン値 ${chen}</span>` : ""}
      </div>
      <div class="pod-stack">💰 ${hero.stack}</div>
      ${hero.streetBet > 0 ? `<div class="pod-bet">ベット: ${hero.streetBet}</div>` : ""}
    </div>`;
}

function renderActions() {
  const bar = $("#action-buttons");
  const info = $("#action-info");
  if (game.handOver) {
    info.textContent = "";
    bar.innerHTML = `<button class="act-btn next" id="next-hand-btn">▶ 次のハンド</button>`;
    $("#next-hand-btn").addEventListener("click", startNextHand);
    return;
  }
  const cp = game.currentPlayer();
  const hero = game.hero();
  if (!cp || !cp.isHero) {
    info.textContent = cp ? `${cp.name} の番です…` : "…";
    bar.innerHTML = "";
    return;
  }
  const toCall = Math.min(game.currentBet - hero.streetBet, hero.stack);
  const pot = game.totalPot();
  info.textContent = toCall > 0
    ? `あなたの番 — コールに ${toCall} 必要(ポット ${pot})`
    : `あなたの番 — チェック可能(ポット ${pot})`;

  const btns = [];
  btns.push(`<button class="act-btn fold" data-act="fold">フォールド</button>`);
  if (toCall <= 0) {
    btns.push(`<button class="act-btn check" data-act="check">チェック</button>`);
  } else {
    btns.push(`<button class="act-btn call" data-act="call">コール ${toCall}</button>`);
  }
  // レイズ系(スタックが残っている場合)
  if (hero.stack > toCall) {
    const minTo = Math.min(game.currentBet + game.minRaise, hero.streetBet + hero.stack);
    const sizes = [];
    const potAfterCall = pot + toCall;
    const half = Math.round((game.currentBet + potAfterCall * 0.5) / 10) * 10;
    const full = Math.round((game.currentBet + potAfterCall * 1.0) / 10) * 10;
    const allIn = hero.streetBet + hero.stack;
    sizes.push({ label: `ミニマム ${minTo}`, to: minTo });
    if (half > minTo && half < allIn) sizes.push({ label: `1/2ポット ${half}`, to: half });
    if (full > minTo && full < allIn && full !== half) sizes.push({ label: `ポット ${full}`, to: full });
    sizes.push({ label: `オールイン ${allIn}`, to: allIn });
    const verb = game.currentBet > 0 ? "レイズ" : "ベット";
    for (const s of sizes) {
      btns.push(`<button class="act-btn raise" data-act="raise" data-to="${s.to}">${verb} ${s.label}</button>`);
    }
  }
  bar.innerHTML = btns.join("");
  bar.querySelectorAll("[data-act]").forEach((b) => {
    b.addEventListener("click", () => {
      const act = b.dataset.act;
      if (act === "raise") heroAct({ type: "raise", raiseTo: parseInt(b.dataset.to, 10) });
      else heroAct({ type: act });
    });
  });
}

function renderQuickStats() {
  const r = roi();
  $("#qs-roi").textContent = r === null ? "—" : r.toFixed(1) + "%";
  $("#qs-roi").className = r !== null && r >= 100 ? "good" : "bad";
  const profit = stats.returned - stats.invested; // ハンド確定分のみ
  $("#qs-profit").textContent = (profit >= 0 ? "+" : "") + profit;
  $("#qs-profit").className = profit >= 0 ? "good" : "bad";
}

function appendLog(text, cls) {
  const div = document.createElement("div");
  div.className = "log-line " + (cls || "");
  div.textContent = text;
  const log = $("#log");
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ------------------------------------------------------------
// 学習パネル
// ------------------------------------------------------------
function mainOpponent() {
  const aiActive = game.activePlayers().filter((p) => !p.isHero);
  if (aiActive.length === 0) return null;
  const sel = $("#range-opp-select").value;
  const found = aiActive.find((p) => p.name === sel);
  if (found) return found;
  if (game.lastAggressor && !game.lastAggressor.isHero && !game.lastAggressor.folded) {
    return game.lastAggressor;
  }
  return aiActive[0];
}

function renderStudy() {
  if (!$("#study-toggle").checked) {
    $("#study-content").style.display = "none";
    return;
  }
  $("#study-content").style.display = "";
  const hero = game.hero();

  // レンジ表示相手のセレクタ
  const aiPlayers = game.players.filter((p) => !p.isHero);
  const sel = $("#range-opp-select");
  const prevSel = sel.value;
  sel.innerHTML = aiPlayers
    .map((p) => `<option value="${p.name}"${p.folded ? " disabled" : ""}>${p.name}</option>`)
    .join("");
  if ([...sel.options].some((o) => o.value === prevSel && !o.disabled)) sel.value = prevSel;

  if (hero.folded || game.handOver || hero.hole.length === 0) {
    $("#eq-random-val").textContent = "—";
    $("#eq-range-val").textContent = "—";
    $("#eq-random-fill").style.width = "0";
    $("#eq-range-fill").style.width = "0";
    $("#eq-method").textContent = "";
    $("#pot-odds-body").textContent = "—";
    $("#draws-body").textContent = "—";
    $("#coach-body").textContent = game.handOver ? "次のハンドを開始してください" : "フォールド済み";
    renderRangeGrid();
    return;
  }

  const opps = game.activePlayers().length - 1;
  if (opps < 1) return;

  // エクイティ計算(キャッシュ: 同一ストリート・同一相手数なら再計算しない)
  const cacheKey = `${game.street}:${opps}:${game.board.length}:${$("#range-opp-select").value}:${game.log.length}`;
  let eq = handState.cachedEquity;
  if (!eq || eq.key !== cacheKey) {
    const eqRandom = calcEquity(hero.hole, game.board, opps, { iterations: 3000 });
    let eqRange = null;
    const mo = mainOpponent();
    if (mo && mo.range) {
      eqRange = calcEquity(hero.hole, game.board, opps, {
        iterations: 2500, forceMC: true, oppRange: mo.range,
      });
    }
    eq = { key: cacheKey, random: eqRandom, range: eqRange, oppName: mo ? mo.name : null };
    handState.cachedEquity = eq;
  }

  const pctR = eq.random.equity * 100;
  $("#eq-random-val").textContent = pctR.toFixed(1) + "%";
  $("#eq-random-fill").style.width = Math.min(100, pctR) + "%";
  if (eq.range) {
    const pctG = eq.range.equity * 100;
    $("#eq-range-val").textContent = pctG.toFixed(1) + "%";
    $("#eq-range-fill").style.width = Math.min(100, pctG) + "%";
  } else {
    $("#eq-range-val").textContent = "—";
    $("#eq-range-fill").style.width = "0";
  }
  $("#eq-method").textContent =
    (eq.random.method === "exact"
      ? `計算方式: 完全確率計算(全探索 ${eq.random.iterations.toLocaleString()}通り)`
      : `計算方式: モンテカルロ法(${eq.random.iterations.toLocaleString()}回試行)`) +
    (eq.range && eq.oppName ? ` / レンジは${eq.oppName}のアクションから推定` : "");

  // ポットオッズ
  const toCall = Math.max(0, Math.min(game.currentBet - hero.streetBet, hero.stack));
  const pot = game.totalPot();
  if (toCall > 0) {
    const needed = (toCall / (pot + toCall)) * 100;
    $("#pot-odds-body").innerHTML =
      `コール <b>${toCall}</b> / ポット <b>${pot}</b><br>` +
      `必要勝率 = ${toCall} ÷ (${pot} + ${toCall}) = <b>${needed.toFixed(1)}%</b><br>` +
      `<span class="${(eq.range ? eq.range.equity : eq.random.equity) * 100 >= needed ? "good" : "bad"}">` +
      `エクイティ${((eq.range ? eq.range.equity : eq.random.equity) * 100).toFixed(1)}% ${((eq.range ? eq.range.equity : eq.random.equity) * 100 >= needed) ? "≥" : "<"} 必要勝率${needed.toFixed(1)}%</span>`;
  } else {
    $("#pot-odds-body").textContent = "ベットに直面していません(チェック可能)";
  }

  // ドロー
  const draws = detectDraws(hero.hole, game.board);
  if (game.board.length >= 3 && game.board.length < 5) {
    if (draws.length) {
      const streetsLeft = game.board.length === 3 ? 2 : 1;
      $("#draws-body").innerHTML = draws
        .map((d) => {
          const est = d.outs * (streetsLeft === 2 ? 4 : 2);
          return `${d.label}: アウツ約<b>${d.outs}</b>枚 → ${streetsLeft === 2 ? "4倍" : "2倍"}ルールで約${est}%`;
        })
        .join("<br>");
    } else {
      $("#draws-body").textContent = "主要なドローはありません";
    }
  } else {
    $("#draws-body").textContent = game.board.length === 5 ? "リバー(ドローなし)" : "フロップ以降に表示";
  }

  // 推奨アクション
  renderCoach(eq, toCall, pot, draws);
  renderRangeGrid();
}

function renderCoach(eq, toCall, pot, draws) {
  const hero = game.hero();
  const cp = game.currentPlayer();
  if (!cp || !cp.isHero) {
    $("#coach-body").innerHTML = "<span class='muted'>あなたの手番になると表示されます</span>";
    return;
  }
  const useEq = eq.range ? eq.range.equity : eq.random.equity;
  const eqSrc = eq.range ? "推定レンジに対するエクイティ" : "エクイティ";
  let advice, reason;

  if (game.street === "preflop") {
    const chen = chenScore(hero.hole);
    const facingRaise = game.currentBet > game.bigBlind;
    const needed = toCall > 0 ? toCall / (pot + toCall) : 0;
    if (!facingRaise && toCall > 0 && toCall <= game.bigBlind / 2 && chen < 7) {
      // SBの割引コールなど、オッズは合うが弱いハンドの場合
      $("#coach-body").innerHTML =
        `<div class="advice">コール or フォールド</div>` +
        `<div class="reason">割引価格(必要勝率${(needed * 100).toFixed(0)}%)なのでオッズ上はコール可。ただしチェン値${chen}の弱いハンドはポジション不利だと以後の判断が難しく、フォールドも十分あり</div>` +
        `<div class="coach-note">※ 簡易的な目安です。GTOの正確な混合戦略はソルバーの領域(学習タブ⑥⑦参照)</div>`;
      return;
    }
    if (chen >= 10) {
      advice = "レイズ";
      reason = `チェン値${chen}のプレミアムハンド。バリューのためにポットを膨らませたい`;
    } else if (chen >= 7 && !facingRaise) {
      advice = "レイズ or コール";
      reason = `チェン値${chen}は十分プレイ可能。オープンならレイズが基本`;
    } else if (facingRaise && chen < 8) {
      advice = toCall > 0 ? "フォールド" : "チェック";
      reason = `レイズに対してチェン値${chen}は分が悪い。無理せず次のハンドへ`;
    } else if (toCall <= 0) {
      advice = "チェック";
      reason = "無料で見られるならフロップを見よう";
    } else if (chen >= 5 && toCall <= game.bigBlind) {
      advice = "コール";
      reason = `チェン値${chen}。安く見られるならフロップを見る価値あり`;
    } else {
      advice = "フォールド";
      reason = `チェン値${chen}の弱いハンド。参加コストに見合わない`;
    }
  } else if (toCall > 0) {
    const needed = toCall / (pot + toCall);
    if (useEq >= needed + 0.22) {
      advice = "レイズ(バリュー)";
      reason = `${eqSrc} ${(useEq * 100).toFixed(0)}% は必要勝率 ${(needed * 100).toFixed(0)}% を大きく上回る。相手のより弱い手から取りに行こう`;
    } else if (useEq >= needed) {
      advice = "コール";
      reason = `${eqSrc} ${(useEq * 100).toFixed(0)}% ≥ 必要勝率 ${(needed * 100).toFixed(0)}%。数学的にコールはプラス`;
    } else if (draws.length && game.street !== "river" && useEq >= needed * 0.75) {
      advice = "コール(やや薄い)";
      reason = `直接オッズは足りないが、${draws[0].label}が完成すれば大きく取れる(インプライドオッズ)`;
    } else {
      advice = "フォールド";
      reason = `${eqSrc} ${(useEq * 100).toFixed(0)}% < 必要勝率 ${(needed * 100).toFixed(0)}%。コールは長期的にマイナス`;
    }
  } else {
    if (useEq >= 0.68) {
      advice = "ベット(バリュー)";
      reason = `${eqSrc} ${(useEq * 100).toFixed(0)}% と有利。チェックで無料カードを与えずベットで取りに行こう`;
    } else if (draws.length && game.street !== "river") {
      advice = "チェック or セミブラフベット";
      reason = `${draws[0].label}あり。ベットなら「降ろして勝ち」「引いて勝ち」の2つの勝ち筋(セミブラフ)`;
    } else if (useEq >= 0.45) {
      advice = "チェック";
      reason = `${eqSrc} ${(useEq * 100).toFixed(0)}% は互角圏。無理にポットを膨らませる必要はない`;
    } else {
      advice = "チェック";
      reason = `${eqSrc} ${(useEq * 100).toFixed(0)}% と不利。ブラフは相手の傾向を見てから`;
    }
  }
  $("#coach-body").innerHTML =
    `<div class="advice">${advice}</div><div class="reason">${reason}</div>` +
    `<div class="coach-note">※ 簡易的な目安です。GTOの正確な混合戦略はソルバーの領域(学習タブ⑥⑦参照)</div>`;
}

// 13x13 レンジグリッド
function renderRangeGrid() {
  const gridEl = $("#range-grid");
  const noteEl = $("#range-note");
  const mo = game.players.find((p) => !p.isHero && p.name === $("#range-opp-select").value) ||
    game.players.find((p) => !p.isHero && !p.folded);
  if (!mo || !mo.range || mo.folded) {
    gridEl.innerHTML = "";
    noteEl.textContent = mo && mo.folded ? `${mo.name} はフォールドしました` : "";
    return;
  }
  const grid = rangeToGrid(mo.range);
  const pct = rangePercent(mo.range);
  noteEl.innerHTML = `${mo.name}(${mo.personality.label})が持ち得るハンド — 濃いほど可能性が高い<br>` +
    `<small>アクションから推定したレンジの広さ: 全ハンドの約${pct.toFixed(0)}%相当</small>`;
  let html = "";
  for (let hi = 12; hi >= 0; hi--) {
    for (let lo = 12; lo >= 0; lo--) {
      let label;
      if (hi === lo) label = RANKS[hi] + RANKS[lo];
      else if (hi > lo) label = RANKS[hi] + RANKS[lo] + "s";
      else label = RANKS[lo] + RANKS[hi] + "o";
      const w = grid[label] || 0;
      const cls = hi === lo ? " pair" : hi > lo ? " suited" : "";
      html += `<div class="rg-cell${cls}" style="--w:${w.toFixed(3)}" title="${label}: 相対的な持ちやすさ ${(w * 100).toFixed(0)}%">${label}</div>`;
    }
  }
  gridEl.innerHTML = html;
}

// ------------------------------------------------------------
// 学習タブ: レッスン + クイズ
// ------------------------------------------------------------
function renderLessons() {
  $("#lessons").innerHTML = LESSONS.map(
    (l) => `<details class="lesson"><summary>${l.title}</summary><div class="lesson-body">${l.body}</div></details>`
  ).join("");
}

function renderGlossary() {
  $("#glossary").innerHTML = GLOSSARY.map(
    ([t, d]) => `<div class="gl-item"><dt>${t}</dt><dd>${d}</dd></div>`
  ).join("");
}

// エクイティクイズ
let eqQuizState = null;
function newEquityQuiz() {
  const deck = shuffle(freshDeck());
  const hole = [deck.pop(), deck.pop()];
  const boardLen = Math.random() < 0.4 ? 0 : Math.random() < 0.6 ? 3 : 4;
  const board = [];
  for (let i = 0; i < boardLen; i++) board.push(deck.pop());
  const r = calcEquity(hole, board, 1, { iterations: 8000 });
  const truePct = r.equity * 100;
  // 選択肢生成: 正解を5%刻みに丸め、±の誤答を混ぜる
  const correct = Math.round(truePct / 5) * 5;
  const opts = new Set([correct]);
  const offsets = [-25, -15, -10, 10, 15, 25];
  shuffle(offsets);
  for (const off of offsets) {
    if (opts.size >= 4) break;
    const v = correct + off;
    if (v >= 5 && v <= 95) opts.add(v);
  }
  const options = shuffle([...opts]);
  eqQuizState = { hole, board, truePct, correct, method: r.method };

  $("#equity-quiz").innerHTML = `
    <div class="quiz-cards">
      <div class="quiz-cardrow"><span>手札:</span>${hole.map((c) => cardEl(c)).join("")}</div>
      <div class="quiz-cardrow"><span>ボード:</span>${
        board.length ? board.map((c) => cardEl(c)).join("") : "<em>(プリフロップ)</em>"
      }</div>
    </div>
    <div class="quiz-options">
      ${options.map((o) => `<button class="quiz-opt" data-v="${o}">約${o}%</button>`).join("")}
    </div>
    <div class="quiz-feedback"></div>`;
  document.querySelectorAll("#equity-quiz .quiz-opt").forEach((b) => {
    b.addEventListener("click", () => answerEquityQuiz(parseInt(b.dataset.v, 10)));
  });
}
function answerEquityQuiz(v) {
  const { truePct, correct, method } = eqQuizState;
  stats.eqQuiz++;
  const ok = v === correct;
  if (ok) stats.eqQuizCorrect++;
  saveStats();
  renderStatsTab();
  $("#equity-quiz .quiz-feedback").innerHTML =
    `<div class="${ok ? "good" : "bad"}">${ok ? "🎉 正解!" : "❌ 不正解…"} 実際のエクイティは <b>${truePct.toFixed(1)}%</b>
    <small>(${method === "exact" ? "全探索" : "モンテカルロ法8,000回"}で計算)</small></div>
    <button class="quiz-next">次の問題</button>`;
  document.querySelectorAll("#equity-quiz .quiz-opt").forEach((b) => (b.disabled = true));
  $("#equity-quiz .quiz-next").addEventListener("click", newEquityQuiz);
}

// 役判定クイズ
let rankQuizState = null;
function newRankQuiz() {
  const deck = shuffle(freshDeck());
  const cards = deck.slice(0, 7);
  const score = evaluate7(cards);
  const cat = scoreCategory(score);
  const opts = new Set([cat]);
  const pool = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8].filter((c) => c !== cat));
  while (opts.size < 4 && pool.length) opts.add(pool.pop());
  const options = shuffle([...opts]);
  rankQuizState = { cards, score, cat };
  $("#rank-quiz").innerHTML = `
    <div class="quiz-cards"><div class="quiz-cardrow">${cards.map((c) => cardEl(c)).join("")}</div></div>
    <div class="quiz-options">
      ${options.map((o) => `<button class="quiz-opt" data-v="${o}">${HAND_CAT_NAMES[o]}</button>`).join("")}
    </div>
    <div class="quiz-feedback"></div>`;
  document.querySelectorAll("#rank-quiz .quiz-opt").forEach((b) => {
    b.addEventListener("click", () => answerRankQuiz(parseInt(b.dataset.v, 10)));
  });
}
function answerRankQuiz(v) {
  const { score, cat } = rankQuizState;
  stats.rankQuiz++;
  const ok = v === cat;
  if (ok) stats.rankQuizCorrect++;
  saveStats();
  renderStatsTab();
  $("#rank-quiz .quiz-feedback").innerHTML =
    `<div class="${ok ? "good" : "bad"}">${ok ? "🎉 正解!" : "❌ 不正解…"} 最強の役は <b>${describeScore(score)}</b></div>
    <button class="quiz-next">次の問題</button>`;
  document.querySelectorAll("#rank-quiz .quiz-opt").forEach((b) => (b.disabled = true));
  $("#rank-quiz .quiz-next").addEventListener("click", newRankQuiz);
}

// ------------------------------------------------------------
// 成績タブ
// ------------------------------------------------------------
function renderStatsTab() {
  const r = roi();
  $("#stat-roi").textContent = r === null ? "—" : r.toFixed(1) + "%";
  $("#stat-roi").className = r !== null && r >= 100 ? "good" : "bad";
  $("#stat-invested").textContent = stats.invested.toLocaleString();
  $("#stat-returned").textContent = stats.returned.toLocaleString();

  const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(0) + "%" : "—");
  const rows = [
    ["プレイしたハンド", stats.hands],
    ["ポット獲得ハンド", `${stats.handsWon} (${pct(stats.handsWon, stats.hands)})`],
    ["ショーダウン勝率", `${stats.showdownsWon}/${stats.showdowns} (${pct(stats.showdownsWon, stats.showdowns)})`],
    ["VPIP(自発的参加率)", pct(stats.vpipHands, stats.hands)],
    ["収支", (stats.returned - stats.invested >= 0 ? "+" : "") + (stats.returned - stats.invested)],
    ["ハンド読み的中率", `${stats.predictionsCorrect}/${stats.predictions} (${pct(stats.predictionsCorrect, stats.predictions)})`],
    ["エクイティクイズ", `${stats.eqQuizCorrect}/${stats.eqQuiz} (${pct(stats.eqQuizCorrect, stats.eqQuiz)})`],
    ["役判定クイズ", `${stats.rankQuizCorrect}/${stats.rankQuiz} (${pct(stats.rankQuizCorrect, stats.rankQuiz)})`],
  ];
  $("#stats-grid").innerHTML = rows
    .map(([k, v]) => `<div class="stat-cell"><div class="stat-k">${k}</div><div class="stat-v">${v}</div></div>`)
    .join("");
  renderBankrollChart();
}

function renderBankrollChart() {
  const h = stats.bankrollHistory;
  const el = $("#bankroll-chart");
  if (h.length < 2) {
    el.innerHTML = "<p class='muted'>ハンドをプレイすると推移が表示されます</p>";
    return;
  }
  const W = 640, H = 200, pad = 30;
  const min = Math.min(...h, 0), max = Math.max(...h, 0);
  const range = max - min || 1;
  const x = (i) => pad + (i / (h.length - 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - min) / range) * (H - pad * 2);
  const points = h.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const zeroY = y(0);
  const last = h[h.length - 1];
  el.innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    <line x1="${pad}" y1="${zeroY}" x2="${W - pad}" y2="${zeroY}" class="chart-zero"/>
    <polyline points="${points}" class="chart-line ${last >= 0 ? "up" : "down"}"/>
    <text x="${pad}" y="${y(max) - 6}" class="chart-label">${max}</text>
    <text x="${pad}" y="${y(min) + 14}" class="chart-label">${min}</text>
    <text x="${W - pad}" y="${y(last) - 6}" text-anchor="end" class="chart-label">${last >= 0 ? "+" : ""}${last}</text>
  </svg>`;
}

// ------------------------------------------------------------
// タブ切り替えと初期化
// ------------------------------------------------------------
function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $("#tab-" + btn.dataset.tab).classList.add("active");
      if (btn.dataset.tab === "stats") renderStatsTab();
    });
  });
}

// ウォッチドッグ: タブのバックグラウンド化などでAIの思考タイマーが
// 止まった/失われた場合に進行を自動復旧する
function watchdog() {
  if (!game || game.handOver) return;
  if (Date.now() - lastActivity < 2500) return; // 直近に動きがあれば何もしない
  const cp = game.currentPlayer();
  if (cp && !cp.isHero) {
    proceed(); // AIの手番が放置されている → タイマーを掛け直す
  } else if (!cp && game.street !== "showdown") {
    game.endStreet(); // ランアウト中のタイマーが失われた → 進める
  } else if (cp && cp.isHero) {
    renderAll(); // 描画だけ取り残された場合に備えて再描画
  }
}
setInterval(watchdog, 3000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) setTimeout(watchdog, 300); // タブ復帰時に即チェック
});

document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  renderLessons();
  renderGlossary();
  newEquityQuiz();
  newRankQuiz();
  renderStatsTab();
  $("#study-toggle").addEventListener("change", renderStudy);
  $("#range-opp-select").addEventListener("change", () => {
    handState.cachedEquity = null;
    renderStudy();
  });
  $("#new-game-btn").addEventListener("click", newGame);
  $("#ai-count").addEventListener("change", newGame);
  $("#stats-reset").addEventListener("click", () => {
    if (confirm("成績を全てリセットしますか?")) {
      stats = defaultStats();
      saveStats();
      renderStatsTab();
      renderQuickStats();
    }
  });
  newGame();
});
