// ============================================================
// poker.js — カード / 役判定 / エクイティ計算(全探索 & モンテカルロ)
// ============================================================
"use strict";

const RANKS = "23456789TJQKA"; // index 0..12 (12 = A)
const SUITS = "shdc";          // spade, heart, diamond, club
const SUIT_CHARS = { s: "♠", h: "♥", d: "♦", c: "♣" };
const RANK_JP = { T: "10", J: "J", Q: "Q", K: "K", A: "A" };

// カードは 0..51 の整数: card = rank * 4 + suit
function makeCard(rank, suit) { return rank * 4 + suit; }
function cardRank(c) { return c >> 2; }
function cardSuit(c) { return c & 3; }
function cardStr(c) {
  const r = RANKS[cardRank(c)];
  return (RANK_JP[r] || r) + SUIT_CHARS[SUITS[cardSuit(c)]];
}
function cardCode(c) { return RANKS[cardRank(c)] + SUITS[cardSuit(c)]; }
function parseCard(code) {
  return makeCard(RANKS.indexOf(code[0]), SUITS.indexOf(code[1]));
}

function freshDeck() {
  const d = [];
  for (let i = 0; i < 52; i++) d.push(i);
  return d;
}
function shuffle(deck, rng) {
  rng = rng || Math.random;
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ------------------------------------------------------------
// 7枚から最強の5枚役を直接判定して数値スコアを返す
// スコアが大きいほど強い。カテゴリ: 8=SF 7=クアッズ 6=フルハウス
// 5=フラッシュ 4=ストレート 3=トリップス 2=ツーペア 1=ワンペア 0=ハイカード
// ------------------------------------------------------------
const HAND_CAT_NAMES = [
  "ハイカード", "ワンペア", "ツーペア", "スリーカード",
  "ストレート", "フラッシュ", "フルハウス", "フォーカード", "ストレートフラッシュ",
];
const P13 = [1, 13, 169, 2197, 28561, 371293]; // 13^0..13^5

function packScore(cat, t) {
  // t: 最大5個のタイブレーカー(降順の重要度)
  let s = cat * P13[5];
  for (let i = 0; i < 5; i++) s += (t[i] || 0) * P13[4 - i];
  return s;
}
function scoreCategory(score) { return Math.floor(score / P13[5]); }

// rankMask(13bit)からストレートの最上位ランクを返す。無ければ -1
function straightHigh(mask) {
  for (let h = 12; h >= 4; h--) {
    // h, h-1, h-2, h-3, h-4 が全部立っているか
    const need = 0b11111 << (h - 4);
    if ((mask & need) === need) return h;
  }
  // ホイール A-2-3-4-5 (A=12, 2=0,3=1,4=2,5=3)
  const wheel = (1 << 12) | 0b1111;
  if ((mask & wheel) === wheel) return 3; // 5ハイ
  return -1;
}

// cards: 7枚(5枚や6枚でも動作する)のカード配列 → スコア
function evaluate7(cards) {
  const rankCount = new Array(13).fill(0);
  const suitCount = [0, 0, 0, 0];
  let rankMask = 0;
  for (const c of cards) {
    rankCount[c >> 2]++;
    suitCount[c & 3]++;
    rankMask |= 1 << (c >> 2);
  }

  // フラッシュ / ストレートフラッシュ
  for (let s = 0; s < 4; s++) {
    if (suitCount[s] >= 5) {
      let suitMask = 0;
      for (const c of cards) if ((c & 3) === s) suitMask |= 1 << (c >> 2);
      const sf = straightHigh(suitMask);
      if (sf >= 0) return packScore(8, [sf]);
      // フラッシュ上位5枚
      const t = [];
      for (let r = 12; r >= 0 && t.length < 5; r--) {
        if (suitMask & (1 << r)) t.push(r);
      }
      return packScore(5, t);
    }
  }

  // ランクの集計(降順)
  let quad = -1;
  const trips = [], pairs = [];
  for (let r = 12; r >= 0; r--) {
    if (rankCount[r] === 4) quad = r;
    else if (rankCount[r] === 3) trips.push(r);
    else if (rankCount[r] === 2) pairs.push(r);
  }

  if (quad >= 0) {
    let kicker = -1;
    for (let r = 12; r >= 0; r--) {
      if (r !== quad && rankCount[r] > 0) { kicker = r; break; }
    }
    return packScore(7, [quad, kicker]);
  }
  if (trips.length >= 2) return packScore(6, [trips[0], trips[1]]);
  if (trips.length === 1 && pairs.length >= 1) return packScore(6, [trips[0], pairs[0]]);

  const st = straightHigh(rankMask);
  if (st >= 0) return packScore(4, [st]);

  if (trips.length === 1) {
    const t = [trips[0]];
    for (let r = 12; r >= 0 && t.length < 3; r--) {
      if (rankCount[r] === 1) t.push(r);
    }
    return packScore(3, t);
  }
  if (pairs.length >= 2) {
    const t = [pairs[0], pairs[1]];
    for (let r = 12; r >= 0 && t.length < 3; r--) {
      if (r !== pairs[0] && r !== pairs[1] && rankCount[r] > 0) t.push(r);
    }
    return packScore(2, t);
  }
  if (pairs.length === 1) {
    const t = [pairs[0]];
    for (let r = 12; r >= 0 && t.length < 4; r--) {
      if (rankCount[r] === 1) t.push(r);
    }
    return packScore(1, t);
  }
  const t = [];
  for (let r = 12; r >= 0 && t.length < 5; r--) {
    if (rankCount[r] > 0) t.push(r);
  }
  return packScore(0, t);
}

// 役の日本語説明("Aのワンペア"など)
function describeScore(score) {
  const cat = scoreCategory(score);
  let rest = score - cat * P13[5];
  const t = [];
  for (let i = 4; i >= 0; i--) { t.push(Math.floor(rest / P13[i])); rest %= P13[i]; }
  const rn = (r) => { const s = RANKS[r]; return RANK_JP[s] || s; };
  switch (cat) {
    case 8: return t[0] === 12 ? "ロイヤルフラッシュ" : `${rn(t[0])}ハイのストレートフラッシュ`;
    case 7: return `${rn(t[0])}のフォーカード`;
    case 6: return `${rn(t[0])}と${rn(t[1])}のフルハウス`;
    case 5: return `${rn(t[0])}ハイのフラッシュ`;
    case 4: return `${rn(t[0])}ハイのストレート`;
    case 3: return `${rn(t[0])}のスリーカード`;
    case 2: return `${rn(t[0])}と${rn(t[1])}のツーペア`;
    case 1: return `${rn(t[0])}のワンペア`;
    default: return `${rn(t[0])}ハイ`;
  }
}

// ------------------------------------------------------------
// エクイティ計算
// hero: [c,c], board: 0〜5枚, opponents: 相手の数
// oppRanges: 省略時はランダムハンド。指定時は [{combos:[[c,c],...], weights:[...]}]
// 戻り値: { equity: 0..1, win, tie, method: "exact"|"montecarlo", iterations }
// ------------------------------------------------------------
function calcEquity(hero, board, opponents, opts) {
  opts = opts || {};
  const known = new Set([...hero, ...board]);
  const unseen = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) unseen.push(c);

  // 1対1でターン以降なら全探索(完全確率計算)
  if (opponents === 1 && board.length >= 4 && !opts.forceMC && !opts.oppRange) {
    return exactEquityHeadsUp(hero, board, unseen);
  }
  return monteCarloEquity(hero, board, opponents, unseen, opts);
}

function exactEquityHeadsUp(hero, board, unseen) {
  let win = 0, tie = 0, total = 0;
  const n = unseen.length;
  const boardFull = board.length === 5;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const opp = [unseen[i], unseen[j]];
      if (boardFull) {
        const hs = evaluate7([...hero, ...board]);
        const os = evaluate7([...opp, ...board]);
        total++;
        if (hs > os) win++;
        else if (hs === os) tie++;
      } else {
        // ターン: 残り1枚のリバーを全列挙
        for (let k = 0; k < n; k++) {
          if (k === i || k === j) continue;
          const b = [...board, unseen[k]];
          const hs = evaluate7([...hero, ...b]);
          const os = evaluate7([...opp, ...b]);
          total++;
          if (hs > os) win++;
          else if (hs === os) tie++;
        }
      }
    }
  }
  return {
    equity: (win + tie / 2) / total,
    win: win / total, tie: tie / total,
    method: "exact", iterations: total,
  };
}

function monteCarloEquity(hero, board, opponents, unseen, opts) {
  const iters = opts.iterations || 3000;
  const oppRange = opts.oppRange || null; // 1人目の相手にだけ適用する重み付きレンジ
  let win = 0, tie = 0, tieShare = 0, total = 0;
  const pool = unseen.slice();
  const need = 5 - board.length;

  for (let it = 0; it < iters; it++) {
    // 部分Fisher-Yatesで必要枚数だけ引く
    const drawn = [];
    const used = new Set();

    let oppHands = [];
    if (oppRange) {
      const combo = sampleFromRange(oppRange, used);
      if (!combo) break; // レンジが空
      oppHands.push(combo);
      combo.forEach((c) => used.add(c));
    }
    const needTotal = need + (opponents - oppHands.length) * 2;
    let guard = 0;
    while (drawn.length < needTotal && guard < 1000) {
      const c = pool[Math.floor(Math.random() * pool.length)];
      if (!used.has(c)) { used.add(c); drawn.push(c); }
      guard++;
    }
    if (drawn.length < needTotal) continue;

    let di = 0;
    while (oppHands.length < opponents) {
      oppHands.push([drawn[di], drawn[di + 1]]);
      di += 2;
    }
    const fullBoard = [...board, ...drawn.slice(di, di + need)];

    const hs = evaluate7([...hero, ...fullBoard]);
    let best = -1, bestCount = 0, heroBest = true;
    for (const oh of oppHands) {
      const os = evaluate7([...oh, ...fullBoard]);
      if (os > best) { best = os; bestCount = 1; }
      else if (os === best) bestCount++;
    }
    total++;
    if (hs > best) win++;
    else if (hs === best) { tie++; tieShare += 1 / (bestCount + 1); } // 同着はポットを人数で山分け
  }
  return {
    equity: total ? (win + tieShare) / total : 0,
    win: total ? win / total : 0,
    tie: total ? tie / total : 0,
    method: "montecarlo", iterations: total,
  };
}

function sampleFromRange(range, used) {
  // range: {combos: [[c,c]...], weights: [...]}
  const { combos, weights } = range;
  let totalW = 0;
  const candIdx = [];
  for (let i = 0; i < combos.length; i++) {
    const [a, b] = combos[i];
    if (used.has(a) || used.has(b) || weights[i] <= 0) continue;
    candIdx.push(i);
    totalW += weights[i];
  }
  if (totalW <= 0) return null;
  let r = Math.random() * totalW;
  for (const i of candIdx) {
    r -= weights[i];
    if (r <= 0) return combos[i];
  }
  return combos[candIdx[candIdx.length - 1]];
}

// ------------------------------------------------------------
// プリフロップハンド強度(Chenフォーミュラ)
// ------------------------------------------------------------
function chenScore(hole) {
  const r1 = cardRank(hole[0]), r2 = cardRank(hole[1]);
  const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
  const val = (r) => {
    if (r === 12) return 10;   // A
    if (r === 11) return 8;    // K
    if (r === 10) return 7;    // Q
    if (r === 9) return 6;     // J
    return (r + 2) / 2;        // 10以下は数字の半分
  };
  let score = val(hi);
  if (r1 === r2) return Math.max(5, score * 2);
  if (cardSuit(hole[0]) === cardSuit(hole[1])) score += 2;
  const gap = hi - lo - 1;
  if (gap === 1) score -= 1;
  else if (gap === 2) score -= 2;
  else if (gap === 3) score -= 4;
  else if (gap >= 4) score -= 5;
  if (gap <= 1 && hi < 10) score += 1; // 両カードQ未満のコネクタボーナス
  return Math.ceil(score);
}

// ハンドを "AKs" / "T9o" / "88" 形式に
function handLabel(hole) {
  const r1 = cardRank(hole[0]), r2 = cardRank(hole[1]);
  const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
  if (hi === lo) return RANKS[hi] + RANKS[lo];
  const suited = cardSuit(hole[0]) === cardSuit(hole[1]);
  return RANKS[hi] + RANKS[lo] + (suited ? "s" : "o");
}

// ------------------------------------------------------------
// ドロー検出(フロップ/ターンでの学習表示用)
// ------------------------------------------------------------
function detectDraws(hole, board) {
  if (board.length < 3 || board.length >= 5) return [];
  const cards = [...hole, ...board];
  const draws = [];
  const suitCount = [0, 0, 0, 0];
  for (const c of cards) suitCount[cardSuit(c)]++;
  const holeSuits = hole.map(cardSuit);
  for (let s = 0; s < 4; s++) {
    if (suitCount[s] === 4 && holeSuits.includes(s)) {
      draws.push({ type: "flush", label: "フラッシュドロー", outs: 9 });
      break;
    }
  }
  // ストレートドロー: 残り1枚で完成するランクの数を数える
  let mask = 0;
  for (const c of cards) mask |= 1 << cardRank(c);
  const usedRanks = new Set(cards.map(cardRank));
  let straightOuts = 0;
  for (let r = 0; r < 13; r++) {
    if (usedRanks.has(r)) continue;
    if (straightHigh(mask | (1 << r)) >= 0 && straightHigh(mask) < 0) straightOuts++;
  }
  if (straightOuts > 0 && straightHigh(mask) < 0) {
    // 完成に使えるランクは各4枚(場に出てない前提の概算)
    const outs = straightOuts * 4;
    draws.push({
      type: "straight",
      label: straightOuts >= 2 ? "オープンエンドストレートドロー" : "ガットショットストレートドロー",
      outs,
    });
  }
  return draws;
}

// Node.jsテスト用エクスポート(ブラウザではグローバルのまま)
if (typeof module !== "undefined") {
  module.exports = {
    RANKS, SUITS, makeCard, cardRank, cardSuit, cardStr, cardCode, parseCard,
    freshDeck, shuffle, evaluate7, describeScore, scoreCategory,
    calcEquity, chenScore, handLabel, detectDraws, HAND_CAT_NAMES, packScore,
  };
}
