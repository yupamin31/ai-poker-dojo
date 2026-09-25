// ============================================================
// game.js — テキサスホールデムのゲームエンジン
// (ブラインド、ベッティングラウンド、サイドポット、ショーダウン)
// ============================================================
"use strict";

const STREETS = ["preflop", "flop", "turn", "river", "showdown"];
const STREET_JP = {
  preflop: "プリフロップ", flop: "フロップ", turn: "ターン",
  river: "リバー", showdown: "ショーダウン",
};

class Game {
  constructor(config) {
    this.smallBlind = config.smallBlind || 10;
    this.bigBlind = config.bigBlind || 20;
    this.startStack = config.startStack || 2000;
    this.players = [];
    this.handNumber = 0;
    this.button = -1;
    this.board = [];
    this.deck = [];
    this.street = "preflop";
    this.currentBet = 0;
    this.minRaise = 0;
    this.actingIndex = -1;
    this.needsAction = new Set();
    this.lastAggressor = null; // 直近のベット/レイズをしたプレイヤー
    this.handOver = true;
    this.log = [];
    this.onEvent = config.onEvent || (() => {});

    // ヒーロー
    this.players.push({
      seat: 0, name: "あなた", isHero: true, personality: null,
      stack: this.startStack, hole: [], folded: true, allin: false,
      streetBet: 0, totalBet: 0, rebuys: 0, range: null,
    });
    // AI
    (config.aiKeys || ["tight", "maniac"]).forEach((key, i) => {
      const p = PERSONALITIES[key];
      this.players.push({
        seat: i + 1, name: p.name, isHero: false, personality: p,
        stack: this.startStack, hole: [], folded: true, allin: false,
        streetBet: 0, totalBet: 0, rebuys: 0, range: null,
      });
    });
  }

  hero() { return this.players[0]; }
  totalPot() { return this.players.reduce((s, p) => s + p.totalBet, 0); }
  activePlayers() { return this.players.filter((p) => !p.folded); }
  currentPlayer() {
    return this.actingIndex >= 0 ? this.players[this.actingIndex] : null;
  }

  addLog(text, cls) {
    this.log.push({ hand: this.handNumber, street: this.street, text, cls });
    this.onEvent({ type: "log", text, cls });
  }

  // ------------------------------------------------------------
  startHand() {
    this.handNumber++;
    this.board = [];
    this.street = "preflop";
    this.handOver = false;
    this.lastAggressor = null;
    this.deck = shuffle(freshDeck());

    for (const p of this.players) {
      if (p.stack <= 0) {
        p.stack = this.startStack;
        p.rebuys++;
        this.addLog(`${p.name} がリバイしました(+${this.startStack})`, "sys");
        this.onEvent({ type: "rebuy", player: p });
      }
      p.hole = [this.deck.pop(), this.deck.pop()];
      p.folded = false;
      p.allin = false;
      p.streetBet = 0;
      p.totalBet = 0;
      p.range = null;
    }
    this.button = (this.button + 1) % this.players.length;

    const n = this.players.length;
    const sbIdx = n === 2 ? this.button : (this.button + 1) % n;
    const bbIdx = (sbIdx + 1) % n;
    this.postBlind(this.players[sbIdx], this.smallBlind, "SB");
    this.postBlind(this.players[bbIdx], this.bigBlind, "BB");
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.sbIdx = sbIdx;
    this.bbIdx = bbIdx;

    // 相手レンジの初期化(ヒーロー視点: ヒーローの手札のみ既知)
    for (const p of this.players) {
      if (!p.isHero) p.range = createFullRange(this.hero().hole);
    }

    this.addLog(`── ハンド #${this.handNumber} ── ボタン: ${this.players[this.button].name}`, "hand");

    // プリフロップはBBの左から
    this.wasRaisedThisStreet = false;
    this.needsAction = new Set(
      this.players.filter((p) => !p.folded && !p.allin).map((p) => p.seat)
    );
    this.actingIndex = this.nextActorFrom((bbIdx + 1) % n);
    this.onEvent({ type: "handStart" });
  }

  postBlind(p, amount, label) {
    const paid = Math.min(amount, p.stack);
    p.stack -= paid;
    p.streetBet += paid;
    p.totalBet += paid;
    if (p.stack === 0) p.allin = true;
    if (p.isHero) this.onEvent({ type: "heroInvest", amount: paid });
    this.addLog(`${p.name} が${label} ${paid} をポスト`, "sys");
  }

  // idx から順に(idx含む)、アクションが必要なプレイヤーを探す
  nextActorFrom(idx) {
    const n = this.players.length;
    for (let i = 0; i < n; i++) {
      const j = (idx + i) % n;
      const p = this.players[j];
      if (!p.folded && !p.allin && this.needsAction.has(p.seat)) return j;
    }
    return -1;
  }
  nextActor(afterIdx) {
    return this.nextActorFrom((afterIdx + 1) % this.players.length);
  }

  // ------------------------------------------------------------
  // アクションの適用。player は currentPlayer() であること
  // action: {type, raiseTo?}
  // ------------------------------------------------------------
  applyAction(player, action) {
    // ハンド終了後・ショーダウン待ちのアクションは無視(遅延タイマー対策)
    if (this.handOver || this.street === "showdown") return;
    if (this.players[this.actingIndex] !== player) return;
    const toCall = this.currentBet - player.streetBet;

    if (action.type === "fold") {
      player.folded = true;
      this.needsAction.delete(player.seat);
      this.addLog(`${player.name}: フォールド`, "fold");
    } else if (action.type === "check") {
      if (toCall > 0) throw new Error("check不可: コールが必要");
      this.needsAction.delete(player.seat);
      this.addLog(`${player.name}: チェック`, "check");
    } else if (action.type === "call") {
      const paid = Math.min(toCall, player.stack);
      player.stack -= paid;
      player.streetBet += paid;
      player.totalBet += paid;
      if (player.stack === 0) player.allin = true;
      this.needsAction.delete(player.seat);
      if (player.isHero) this.onEvent({ type: "heroInvest", amount: paid });
      this.addLog(
        `${player.name}: コール ${paid}${player.allin ? " (オールイン)" : ""}`,
        "call"
      );
    } else if (action.type === "raise") {
      let raiseTo = Math.min(action.raiseTo, player.streetBet + player.stack);
      const paid = raiseTo - player.streetBet;
      if (paid <= 0 || raiseTo <= this.currentBet) {
        // 実質コール(オールインで届かない場合)
        return this.applyAction(player, { type: toCall > 0 ? "call" : "check" });
      }
      const increment = raiseTo - this.currentBet;
      player.stack -= paid;
      player.streetBet = raiseTo;
      player.totalBet += paid;
      if (player.stack === 0) player.allin = true;
      this.currentBet = raiseTo;
      if (increment >= this.minRaise) this.minRaise = increment;
      this.lastAggressor = player;
      // 他の全員に再アクション権
      this.needsAction = new Set(
        this.players
          .filter((p) => !p.folded && !p.allin && p !== player)
          .map((p) => p.seat)
      );
      if (player.isHero) this.onEvent({ type: "heroInvest", amount: paid });
      const verb = this.street !== "preflop" && !this.wasRaisedThisStreet ? "ベット" : "レイズ";
      this.wasRaisedThisStreet = true;
      action.verbUsed = verb;
      this.addLog(
        `${player.name}: ${verb} ${raiseTo}${player.allin ? " (オールイン)" : ""}`,
        "raise"
      );
    }

    // レンジ更新(AIのアクションのみ)
    if (!player.isHero && player.range) {
      this.updateRange(player, action, toCall);
    }

    this.onEvent({ type: "action", player, action });
    this.afterAction(player);
  }

  updateRange(player, action, toCall) {
    const p = player.personality;
    let a;
    if (action.type === "fold") return;
    if (this.street === "preflop") {
      a = action.type === "raise" ? "raise" : action.type === "call" && toCall > 0 ? "call" : "check";
      narrowRangePreflop(player.range, a, p);
    } else {
      a = action.type === "raise" ? "bet" : action.type === "call" ? "call" : "check";
      narrowRangePostflop(player.range, this.board, a, p);
    }
    pruneRange(player.range, [...this.hero().hole, ...this.board]);
  }

  afterAction(lastActor) {
    const active = this.activePlayers();
    if (active.length === 1) {
      // 全員フォールド → 即座に勝者へ
      this.awardUncontested(active[0]);
      return;
    }
    if (this.needsAction.size === 0) {
      this.endStreet();
      return;
    }
    this.actingIndex = this.nextActor(lastActor.seat);
    if (this.actingIndex < 0) {
      this.endStreet();
      return;
    }
    this.onEvent({ type: "turnChange" });
  }

  endStreet() {
    if (this.handOver || this.street === "showdown") return; // 二重進行ガード
    for (const p of this.players) p.streetBet = 0;
    this.wasRaisedThisStreet = false;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    const canAct = this.activePlayers().filter((p) => !p.allin);
    const idx = STREETS.indexOf(this.street);

    if (this.street === "river") {
      this.street = "showdown";
      this.actingIndex = -1; // 以後は誰の手番でもない(遅延タイマーが誤動作しないように)
      // ヒーローが残っていればショーダウン前にハンド読みチャレンジを挟む
      const heroIn = !this.hero().folded;
      const aiIn = this.activePlayers().some((p) => !p.isHero);
      if (this.onBeforeShowdown && heroIn && aiIn) {
        this.onBeforeShowdown(() => this.showdown());
      } else {
        this.showdown();
      }
      return;
    }

    // 次のストリートへ
    this.street = STREETS[idx + 1];
    if (this.street === "flop") {
      this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    } else {
      this.board.push(this.deck.pop());
    }
    this.addLog(
      `【${STREET_JP[this.street]}】 ${this.board.map(cardStr).join(" ")}`,
      "street"
    );
    // ボードが変わったのでレンジからデッドカードを除外
    for (const p of this.players) {
      if (!p.isHero && p.range) pruneRange(p.range, [...this.hero().hole, ...this.board]);
    }
    this.onEvent({ type: "street" });

    if (canAct.length <= 1) {
      // 全員オールイン → ランアウト
      this.actingIndex = -1;
      this.onEvent({ type: "runout" });
      setTimeout(() => this.endStreet(), 900);
      return;
    }
    this.needsAction = new Set(canAct.map((p) => p.seat));
    // ポストフロップはボタンの左から
    this.actingIndex = this.nextActorFrom((this.button + 1) % this.players.length);
    this.onEvent({ type: "turnChange" });
  }

  awardUncontested(winner) {
    const pot = this.totalPot();
    winner.stack += pot;
    if (winner.isHero) this.onEvent({ type: "heroReturn", amount: pot });
    this.addLog(`${winner.name} がポット ${pot} を獲得(全員フォールド)`, "win");
    this.finishHand([{ player: winner, amount: pot, reveal: false }]);
  }

  showdown() {
    // サイドポット計算
    const contribs = this.players.map((p) => p.totalBet);
    const pots = [];
    while (Math.max(...contribs) > 0) {
      const level = Math.min(...contribs.filter((c) => c > 0));
      let amt = 0;
      const eligible = [];
      this.players.forEach((p, i) => {
        if (contribs[i] > 0) {
          amt += level;
          contribs[i] -= level;
          if (!p.folded) eligible.push(p);
        }
      });
      const prev = pots[pots.length - 1];
      if (prev && prev.eligible.length === eligible.length &&
          prev.eligible.every((p, i) => p === eligible[i])) {
        prev.amount += amt;
      } else {
        pots.push({ amount: amt, eligible });
      }
    }

    // 各プレイヤーのスコア
    const scores = new Map();
    for (const p of this.activePlayers()) {
      scores.set(p, evaluate7([...p.hole, ...this.board]));
    }

    const results = [];
    pots.forEach((pot, potIdx) => {
      let best = -1;
      for (const p of pot.eligible) best = Math.max(best, scores.get(p));
      const winners = pot.eligible.filter((p) => scores.get(p) === best);
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      for (const w of winners) {
        let amount = share;
        if (remainder > 0) { amount++; remainder--; }
        w.stack += amount;
        if (w.isHero) this.onEvent({ type: "heroReturn", amount });
        const potName = pots.length > 1 ? (potIdx === 0 ? "メインポット" : `サイドポット${potIdx}`) : "ポット";
        this.addLog(
          `${w.name} が${potName} ${amount} を獲得 — ${describeScore(scores.get(w))}`,
          "win"
        );
        results.push({ player: w, amount, reveal: true, score: scores.get(w) });
      }
    });

    for (const p of this.activePlayers()) {
      this.addLog(
        `${p.name}: ${p.hole.map(cardStr).join(" ")} (${describeScore(scores.get(p))})`,
        "reveal"
      );
    }
    this.finishHand(results, scores);
  }

  finishHand(results, scores) {
    this.handOver = true;
    this.actingIndex = -1;
    this.onEvent({ type: "handEnd", results, scores });
  }
}

if (typeof module !== "undefined") {
  module.exports = { Game, STREETS, STREET_JP };
}
