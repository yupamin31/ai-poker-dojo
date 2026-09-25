// ============================================================
// ai.js — AI対戦相手(性格別)とハンドレンジ推定モデル
// ============================================================
"use strict";

// AIの性格プリセット
const PERSONALITIES = {
  tight: {
    key: "tight", name: "健太", label: "タイト・アグレッシブ",
    desc: "強いハンドしか参加しないが、参加したら積極的に攻める",
    raiseChen: 9, callChen: 6, aggression: 1.0, bluffFreq: 0.12, callBias: 0.95,
  },
  loose: {
    key: "loose", name: "さくら", label: "ルース・パッシブ",
    desc: "広いハンドで参加してコールが多い。降ろしにくい",
    raiseChen: 10, callChen: 4, aggression: 0.55, bluffFreq: 0.06, callBias: 1.25,
  },
  maniac: {
    key: "maniac", name: "剛", label: "アグレッシブ・ブラフ多め",
    desc: "ベットとレイズが多くブラフも打つ。捕まえるとおいしい",
    raiseChen: 7, callChen: 4, aggression: 1.4, bluffFreq: 0.30, callBias: 1.05,
  },
};

// ------------------------------------------------------------
// コンボの強さ分類(レンジ更新・AI判断の補助)
// "strong" | "mid" | "draw" | "weak"
// ------------------------------------------------------------
function comboStrength(combo, board) {
  if (board.length < 3) return "mid";
  const score = evaluate7([...combo, ...board]);
  const cat = scoreCategory(score);
  const boardScore = evaluate7(board);
  const topBoardRank = Math.max(...board.map(cardRank));

  if (cat >= 2 && score > boardScore) return "strong"; // ツーペア以上(自分のカードが効いている)
  if (cat === 1) {
    const pairRank = Math.floor(score / P13[4]) % 13;
    if (pairRank >= topBoardRank) return "strong"; // トップペア or オーバーペア
    return "mid";
  }
  if (board.length < 5 && detectDraws(combo, board).length > 0) return "draw";
  return "weak";
}

// ------------------------------------------------------------
// レンジモデル: 相手が持ち得る全コンボと重み
// ------------------------------------------------------------
function createFullRange(deadCards) {
  const dead = new Set(deadCards);
  const combos = [], weights = [];
  for (let a = 0; a < 52; a++) {
    if (dead.has(a)) continue;
    for (let b = a + 1; b < 52; b++) {
      if (dead.has(b)) continue;
      combos.push([a, b]);
      weights.push(1);
    }
  }
  return { combos, weights };
}

// プリフロップのアクションでレンジを絞る
function narrowRangePreflop(range, action, p) {
  for (let i = 0; i < range.combos.length; i++) {
    const chen = chenScore(range.combos[i]);
    let w;
    if (action === "raise") {
      w = chen >= p.raiseChen ? 1 : chen >= p.callChen ? 0.25 : 0.05 + p.bluffFreq * 0.3;
    } else if (action === "call") {
      w = chen >= p.raiseChen + 2 ? 0.25 : chen >= p.callChen ? 1 : 0.1;
    } else { // check(BBの無料参加)
      w = chen >= p.raiseChen ? 0.3 : 1;
    }
    range.weights[i] *= w;
  }
}

// ポストフロップのアクションでレンジを絞る
function narrowRangePostflop(range, board, action, p) {
  for (let i = 0; i < range.combos.length; i++) {
    const s = comboStrength(range.combos[i], board);
    let w;
    if (action === "bet" || action === "raise") {
      w = s === "strong" ? 1 : s === "draw" ? 0.7 : s === "mid" ? 0.3 : 0.1 + p.bluffFreq;
    } else if (action === "call") {
      w = s === "strong" ? 0.6 : s === "draw" ? 1 : s === "mid" ? 1 : 0.15;
    } else { // check
      w = s === "strong" ? 0.35 : s === "draw" ? 0.9 : s === "mid" ? 1 : 1;
    }
    range.weights[i] *= w;
  }
}

// ボード/ヒーローのカードと衝突するコンボを除外
function pruneRange(range, deadCards) {
  const dead = new Set(deadCards);
  for (let i = 0; i < range.combos.length; i++) {
    const [a, b] = range.combos[i];
    if (dead.has(a) || dead.has(b)) range.weights[i] = 0;
  }
}

// 13x13グリッド表示用に、ラベルごとの平均重みを集計
// 戻り値: { "AKs": 0.8, "QQ": 1, ... } (重み0のみのラベルは0)
function rangeToGrid(range) {
  const sum = {}, cnt = {};
  let maxAvg = 0;
  for (let i = 0; i < range.combos.length; i++) {
    const label = handLabel(range.combos[i]);
    sum[label] = (sum[label] || 0) + range.weights[i];
    cnt[label] = (cnt[label] || 0) + 1;
  }
  const grid = {};
  for (const label in sum) {
    grid[label] = sum[label] / cnt[label];
    if (grid[label] > maxAvg) maxAvg = grid[label];
  }
  if (maxAvg > 0) for (const label in grid) grid[label] /= maxAvg; // 0..1に正規化
  return grid;
}

// レンジ内の上位何%が残っているかの概算
function rangePercent(range) {
  let w = 0, n = 0;
  for (let i = 0; i < range.combos.length; i++) {
    w += range.weights[i];
    n++;
  }
  return n ? (w / n) * 100 : 0;
}

// ------------------------------------------------------------
// AIの意思決定
// state から必要な情報を受け取り、アクションを返す
// 戻り値: {type:"fold"|"check"|"call"|"raise", raiseTo?}
// ------------------------------------------------------------
function aiDecide(player, state) {
  const p = player.personality;
  const toCall = Math.min(state.currentBet - player.streetBet, player.stack);
  const pot = state.totalPot();
  const canCheck = toCall <= 0;
  const rnd = Math.random();
  const activeOpps = state.players.filter((x) => x !== player && !x.folded).length;

  if (state.street === "preflop") {
    return aiPreflop(player, state, p, toCall, pot, canCheck, rnd);
  }

  // ポストフロップ: モンテカルロで自分のエクイティを概算
  const eq = calcEquity(player.hole, state.board, activeOpps, {
    iterations: 400, forceMC: true,
  }).equity;
  const strength = comboStrength(player.hole, state.board);
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;

  if (canCheck) {
    // ベットするか？
    let betProb = 0;
    if (eq > 0.72) betProb = 0.85;
    else if (eq > 0.58) betProb = 0.55;
    else if (strength === "draw") betProb = 0.4; // セミブラフ
    else betProb = p.bluffFreq * 0.8;
    betProb *= p.aggression;
    if (rnd < betProb) {
      return makeBet(player, state, pot, eq);
    }
    return { type: "check" };
  }

  // ベットに直面
  const raiseProb =
    (eq > potOdds + 0.22 ? 0.5 : eq > potOdds + 0.12 ? 0.2 : 0) * p.aggression +
    (strength === "weak" && state.street !== "river" ? p.bluffFreq * 0.25 : 0);
  if (rnd < raiseProb && player.stack > toCall) {
    return makeRaise(player, state, pot);
  }
  const callThreshold = potOdds * (2 - p.callBias); // ルースほど低い閾値でコール
  if (eq >= callThreshold || (strength === "draw" && eq >= potOdds * 0.75 && state.street !== "river")) {
    return { type: "call" };
  }
  // リバーでのヒーローコール(ルースな性格ほど降りない)
  if (state.street === "river" && eq >= potOdds * 0.85 && rnd < (p.callBias - 0.8)) {
    return { type: "call" };
  }
  return { type: "fold" };
}

function aiPreflop(player, state, p, toCall, pot, canCheck, rnd) {
  const chen = chenScore(player.hole) + (rnd * 2 - 1); // ±1の揺らぎ
  const bb = state.bigBlind;
  const facingRaise = state.currentBet > bb;

  if (!facingRaise) {
    // オープン(まだレイズなし)
    if (chen >= p.raiseChen) return makeRaise(player, state, pot);
    if (canCheck) {
      if (chen >= p.raiseChen - 1 && rnd < 0.3 * p.aggression) return makeRaise(player, state, pot);
      return { type: "check" };
    }
    if (chen >= p.callChen) return { type: "call" };
    if (rnd < p.bluffFreq * 0.5) return makeRaise(player, state, pot);
    return { type: "fold" };
  }
  // レイズに直面
  const raiseSizeBB = state.currentBet / bb;
  const penalty = Math.min(3, (raiseSizeBB - 2) * 0.5); // レイズが大きいほど要求値上昇
  if (chen >= p.raiseChen + 2 + penalty) {
    if (rnd < 0.55 * p.aggression) return makeRaise(player, state, pot);
    return { type: "call" };
  }
  if (chen >= p.callChen + penalty * p.callBias) return { type: "call" };
  if (rnd < p.bluffFreq * 0.3 && player.stack > toCall * 3) return makeRaise(player, state, pot);
  return { type: "fold" };
}

function makeBet(player, state, pot, eq) {
  // ポットの50〜80%をベット
  const frac = 0.5 + Math.random() * 0.3 + (eq > 0.8 ? 0.1 : 0);
  let amount = Math.round((pot * frac) / 10) * 10;
  amount = Math.max(amount, state.bigBlind);
  amount = Math.min(amount, player.stack + player.streetBet);
  return { type: "raise", raiseTo: player.streetBet + Math.min(amount, player.stack) };
}

function makeRaise(player, state, pot) {
  const minTo = state.currentBet + state.minRaise;
  let target;
  if (state.street === "preflop" && state.currentBet <= state.bigBlind) {
    target = state.bigBlind * (2.5 + Math.random() * 1.5); // オープンレイズ 2.5-4BB
  } else {
    target = state.currentBet * 2.2 + pot * 0.3;
  }
  target = Math.max(minTo, Math.round(target / 10) * 10);
  const maxTo = player.streetBet + player.stack; // オールイン上限
  if (target >= maxTo) return { type: "raise", raiseTo: maxTo };
  return { type: "raise", raiseTo: target };
}

if (typeof module !== "undefined") {
  module.exports = {
    PERSONALITIES, comboStrength, createFullRange, narrowRangePreflop,
    narrowRangePostflop, pruneRange, rangeToGrid, rangePercent, aiDecide,
  };
}
