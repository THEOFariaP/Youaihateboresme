/**
 * game.js — Hardened Game Logic Manager for YourAIHateBores.me
 *
 * Design goals:
 * - The QUESTIONER is the AI authority for the round.
 * - The HOST only coordinates transport / room continuity.
 * - Round moderation must survive host migration with minimal disruption.
 * - Inputs and inbound payloads are sanitized and length-limited.
 * - State snapshots are emitted to the network layer so a replacement host
 *   can keep the room coherent after takeover.
 */

class GameManager {
  constructor() {
    /** @type {any|null} */
    this.network = null;

    /** @type {any|null} */
    this.ai = null;

    /** @type {any|null} */
    this.ui = null;

    /** @type {'lobby'|'playing'|'round-end'} */
    this.state = "lobby";

    /** @type {'asking'|'waiting-answers'|'validating'|'results'|null} */
    this.roundState = null;

    /** @type {number} */
    this.currentRound = 0;

    /** @type {number} */
    this.questionerIndex = 0;

    /** @type {{id: string, name: string}|null} */
    this.questioner = null;

    /** @type {{id: string, name: string}[]} */
    this.responders = [];

    /** @type {{id: string, name: string}[]} */
    this.playerOrder = [];

    /** @type {string|null} */
    this.currentQuestion = null;

    /** @type {string|null} */
    this.currentWikiUrl = null;

    /** @type {Map<string, {text: string, playerName: string, timestamp: number}>} */
    this.answers = new Map();

    /** @type {Set<string>} */
    this.skips = new Set();

    /** @type {Map<string, number>} */
    this.scores = new Map();

    /** @type {number|null} */
    this.timer = null;

    /** @type {number} */
    this.timeLeft = 60;

    /** @type {boolean} */
    this._evaluating = false;

    /** @type {boolean} */
    this._recovering = false;

    /** @type {string|null} */
    this.roundAuthorityId = null;

    /** @type {Object<string, {valid: boolean, reason: string}>} */
    this.lastValidations = {};

    /** @type {string|null} */
    this.lastResultReason = null;

    /** @type {number|null} */
    this.lastRoundEndedAt = null;

    /** @type {Function|null} */
    this._boundMessageHandler = null;

    /** @type {Function|null} */
    this._boundPlayerLeftHandler = null;

    /** @type {Function|null} */
    this._boundHostChangedHandler = null;

    /** @type {Function|null} */
    this._boundHostMigrationStartedHandler = null;

    this.MAX_QUESTION_LENGTH = 500;
    this.MAX_ANSWER_LENGTH = 1000;
    this.MAX_NAME_LENGTH = 20;
  }

  // ===========================================================================
  // Initialisation
  // ===========================================================================

  /**
   * @param {any} network
   * @param {any} ai
   * @param {any} ui
   */
  init(network, ai, ui) {
    this.network = network;
    this.ai = ai;
    this.ui = ui;

    this._boundMessageHandler = (msg) => this.handleMessage(msg);
    this.network.on("message", this._boundMessageHandler);

    this._boundPlayerLeftHandler = (info) => this._onPlayerLeft(info);
    this.network.on("player-left", this._boundPlayerLeftHandler);

    this._boundHostChangedHandler = (info) => this._onHostChanged(info);
    this.network.on("host-changed", this._boundHostChangedHandler);

    this._boundHostMigrationStartedHandler = (info) =>
      this._onHostMigrationStarted(info);
    this.network.on(
      "host-migration-started",
      this._boundHostMigrationStartedHandler,
    );

    const snapshot = this.network.getRoomSnapshot
      ? this.network.getRoomSnapshot()
      : null;
    if (snapshot && snapshot.gameState) {
      this._hydrateFromSnapshot(snapshot.gameState);
    }

    console.log("[Game] GameManager initialised");
  }

  // ===========================================================================
  // Message Dispatcher
  // ===========================================================================

  /**
   * @param {Object} msg
   */
  handleMessage(msg) {
    if (!msg || typeof msg !== "object" || !msg.type) return;

    switch (msg.type) {
      case "game-start":
        this._handleGameStart(msg);
        break;

      case "game-end":
        this._handleGameEnd(msg);
        break;

      case "new-round":
        this._handleNewRound(msg);
        break;

      case "question":
        this._handleQuestion(msg);
        break;

      case "answer":
        this.receiveAnswer(msg.playerId, msg.playerName, msg.text);
        break;

      case "skip":
        this.receiveSkip(msg.playerId);
        break;

      case "round-result":
        this._handleRoundResult(msg);
        break;

      case "request-new-answers":
        this._handleRequestNewAnswers(msg);
        break;

      default:
        break;
    }
  }

  // ===========================================================================
  // Game Lifecycle
  // ===========================================================================

  startGame() {
    if (!this.network || !this.network.isHost || !this.network.isHost()) {
      console.warn("[Game] startGame() ignored because we are not host.");
      return;
    }

    const players = this._getCanonicalPlayers();
    if (players.length < 3) {
      this._notify("You need at least 3 players to start the game.", "warning");
      return;
    }

    this.playerOrder = players.map((p) => ({ id: p.id, name: p.name }));
    this.scores = new Map();
    for (const p of this.playerOrder) {
      this.scores.set(p.id, 0);
    }

    this.questionerIndex = 0;
    this.currentRound = 0;
    this.state = "playing";
    this.roundState = null;
    this._evaluating = false;
    this.roundAuthorityId = null;

    const startMsg = {
      type: "game-start",
      players: this.playerOrder,
      scores: Object.fromEntries(this.scores),
      questionerIndex: this.questionerIndex,
    };

    this.network.broadcast(startMsg);
    this.handleMessage(startMsg);
    this._syncSnapshot();
    this.startRound();
  }

  /**
   * @param {Object} msg
   */
  _handleGameStart(msg) {
    this.playerOrder = Array.isArray(msg.players)
      ? msg.players.map((p) => ({
          id: this._sanitizePeerId(p.id),
          name: this._sanitizeName(p.name),
        }))
      : [];

    this.playerOrder = this.playerOrder.filter((p) => p.id);

    this.questionerIndex =
      typeof msg.questionerIndex === "number" ? msg.questionerIndex : 0;

    this.state = "playing";
    this.currentRound = 0;
    this.roundState = null;
    this._evaluating = false;
    this.roundAuthorityId = null;

    this.scores = new Map();
    if (msg.scores && typeof msg.scores === "object") {
      for (const [id, score] of Object.entries(msg.scores)) {
        const cleanId = this._sanitizePeerId(id);
        if (!cleanId) continue;
        this.scores.set(cleanId, this._sanitizeScore(score));
      }
    } else {
      for (const p of this.playerOrder) {
        this.scores.set(p.id, 0);
      }
    }

    if (this.ui && typeof this.ui.onGameStart === "function") {
      this.ui.onGameStart(this.playerOrder, this.scores);
    }

    this._syncSnapshot();
  }

  /**
   * @param {Object} msg
   */
  _handleGameEnd(msg) {
    this.stopTimer();
    this.state = "lobby";
    this.roundState = null;
    this._evaluating = false;

    if (msg && msg.scores && typeof msg.scores === "object") {
      this.scores = new Map();
      for (const [id, score] of Object.entries(msg.scores)) {
        const cleanId = this._sanitizePeerId(id);
        if (!cleanId) continue;
        this.scores.set(cleanId, this._sanitizeScore(score));
      }
    }

    if (this.ui && typeof this.ui.onGameEnd === "function") {
      this.ui.onGameEnd(this.getScores(), this._sanitizeText(msg.reason, 200));
    }

    this._syncSnapshot();
  }

  /**
   * @param {string} reason
   */
  endGame(reason = "Game ended") {
    if (!this.network || !this.network.isHost || !this.network.isHost()) return;

    const endMsg = {
      type: "game-end",
      reason: this._sanitizeText(reason, 200),
      scores: Object.fromEntries(this.scores),
    };

    this.network.broadcast(endMsg);
    this.handleMessage(endMsg);
  }

  // ===========================================================================
  // Round Lifecycle
  // ===========================================================================

  startRound() {
    if (!this.network || !this.network.isHost || !this.network.isHost()) return;

    this._refreshPlayerOrderFromNetwork();

    if (this.playerOrder.length < 3) {
      this.endGame("Not enough players remaining (need at least 3).");
      return;
    }

    this.currentRound += 1;
    this._evaluating = false;
    this._recovering = false;

    const questioner =
      this.playerOrder[this.questionerIndex % this.playerOrder.length];

    const responders = [];
    const total = this.playerOrder.length;
    for (let offset = 1; offset <= 2 && offset < total; offset += 1) {
      const idx = (this.questionerIndex + offset) % total;
      responders.push(this.playerOrder[idx]);
    }

    this.questioner = { id: questioner.id, name: questioner.name };
    this.responders = responders.map((r) => ({ id: r.id, name: r.name }));
    this.roundAuthorityId = this.questioner.id;
    this.answers = new Map();
    this.skips = new Set();
    this.currentQuestion = null;
    this.currentWikiUrl = null;
    this.roundState = "asking";
    this.lastValidations = {};
    this.lastResultReason = null;
    this.lastRoundEndedAt = null;

    const roundMsg = {
      type: "new-round",
      roundNum: this.currentRound,
      questioner: this.questioner,
      responders: this.responders,
      roundAuthorityId: this.roundAuthorityId,
      questionerIndex: this.questionerIndex,
      scores: Object.fromEntries(this.scores),
    };

    this.network.broadcast(roundMsg);
    this.handleMessage(roundMsg);
    this._syncSnapshot();
  }

  /**
   * @param {Object} msg
   */
  _handleNewRound(msg) {
    this.currentRound =
      typeof msg.roundNum === "number" ? Math.max(1, msg.roundNum) : 1;
    this.questioner = msg.questioner
      ? {
          id: this._sanitizePeerId(msg.questioner.id),
          name: this._sanitizeName(msg.questioner.name),
        }
      : null;

    this.responders = Array.isArray(msg.responders)
      ? msg.responders
          .map((r) => ({
            id: this._sanitizePeerId(r.id),
            name: this._sanitizeName(r.name),
          }))
          .filter((r) => r.id)
      : [];

    this.roundAuthorityId =
      this._sanitizePeerId(msg.roundAuthorityId) ||
      (this.questioner ? this.questioner.id : null);

    this.questionerIndex =
      typeof msg.questionerIndex === "number"
        ? msg.questionerIndex
        : this.questionerIndex;

    if (msg.scores && typeof msg.scores === "object") {
      this.scores = new Map();
      for (const [id, score] of Object.entries(msg.scores)) {
        const cleanId = this._sanitizePeerId(id);
        if (!cleanId) continue;
        this.scores.set(cleanId, this._sanitizeScore(score));
      }
    }

    this.answers = new Map();
    this.skips = new Set();
    this.currentQuestion = null;
    this.currentWikiUrl = null;
    this.roundState = "asking";
    this.state = "playing";
    this._evaluating = false;
    this._recovering = false;
    this.lastValidations = {};
    this.lastResultReason = null;
    this.lastRoundEndedAt = null;

    this.stopTimer();

    const myRole = this.getMyRole();
    if (this.ui && typeof this.ui.onNewRound === "function") {
      this.ui.onNewRound({
        roundNum: this.currentRound,
        questioner: this.questioner,
        responders: this.responders,
        myRole,
        scores: this.scores,
      });
    }

    this._syncSnapshot();
  }

  // ===========================================================================
  // Questioner Authority
  // ===========================================================================

  /**
   * @param {string} text
   */
  async submitQuestion(text) {
    if (!this.questioner || this.questioner.id !== this._myId()) {
      console.warn(
        "[Game] submitQuestion() ignored because we are not the questioner.",
      );
      return;
    }

    const cleanText = this._sanitizeQuestion(text);
    if (!cleanText) {
      this._notify("Please enter a valid question.", "warning");
      return;
    }

    this.currentQuestion = cleanText;
    this.roundState = "waiting-answers";

    if (this.ui && typeof this.ui.onQuestionSubmitted === "function") {
      this.ui.onQuestionSubmitted(cleanText);
    }

    this._syncSnapshot();

    try {
      this.currentWikiUrl = await this.ai.getWikipediaLink(cleanText);
    } catch (_) {
      this.currentWikiUrl = `https://en.wikipedia.org/wiki/Special:Search/${encodeURIComponent(cleanText)}`;
    }

    const questionMsg = {
      type: "question",
      text: this.currentQuestion,
      wikiUrl: this.currentWikiUrl,
      questionerId: this.questioner.id,
      questionerName: this.questioner.name,
      roundNum: this.currentRound,
      roundAuthorityId: this.roundAuthorityId,
    };

    for (const responder of this.responders) {
      if (!this._isPlayerActive(responder.id)) {
        this.skips.add(responder.id);
        continue;
      }
      this.network.send(responder.id, questionMsg);
    }

    this._syncSnapshot();

    if (this._allRespondersAccountedFor()) {
      await this.evaluateAnswers();
    }
  }

  /**
   * @param {Object} msg
   */
  _handleQuestion(msg) {
    const text = this._sanitizeQuestion(msg.text);
    if (!text) return;

    this.currentQuestion = text;
    this.currentWikiUrl = this._sanitizeWikiUrl(msg.wikiUrl);
    this.roundAuthorityId =
      this._sanitizePeerId(msg.roundAuthorityId) ||
      this.roundAuthorityId ||
      (this.questioner ? this.questioner.id : null);
    this.roundState = "waiting-answers";

    this.startTimer();

    if (this.ui && typeof this.ui.onQuestionReceived === "function") {
      this.ui.onQuestionReceived({
        text: this.currentQuestion,
        wikiUrl: this.currentWikiUrl,
        questionerName: this.questioner ? this.questioner.name : "Questioner",
      });
    }

    this._syncSnapshot();
  }

  // ===========================================================================
  // Responder Actions
  // ===========================================================================

  /**
   * @param {string} text
   */
  submitAnswer(text) {
    if (!this.questioner) return;
    if (this.getMyRole() !== "responder") return;

    const cleanText = this._sanitizeAnswer(text);
    if (!cleanText) {
      this._notify("Please enter a valid answer.", "warning");
      return;
    }

    this.stopTimer();

    const answerMsg = {
      type: "answer",
      playerId: this._myId(),
      playerName: this._myName(),
      text: cleanText,
      roundNum: this.currentRound,
      roundAuthorityId: this.roundAuthorityId,
    };

    this.network.send(this.questioner.id, answerMsg);

    if (this.ui && typeof this.ui.onAnswerSubmitted === "function") {
      this.ui.onAnswerSubmitted();
    }
  }

  skipAnswer() {
    if (!this.questioner) return;
    if (this.getMyRole() !== "responder") return;

    this.stopTimer();

    const skipMsg = {
      type: "skip",
      playerId: this._myId(),
      roundNum: this.currentRound,
      roundAuthorityId: this.roundAuthorityId,
    };

    this.network.send(this.questioner.id, skipMsg);

    if (this.ui && typeof this.ui.onAnswerSkipped === "function") {
      this.ui.onAnswerSkipped();
    }
  }

  // ===========================================================================
  // Questioner receives answers / skips
  // ===========================================================================

  /**
   * @param {string} playerId
   * @param {string} playerName
   * @param {string} text
   */
  receiveAnswer(playerId, playerName, text) {
    if (!this._amRoundAuthority()) return;

    const cleanPlayerId = this._sanitizePeerId(playerId);
    const cleanPlayerName = this._sanitizeName(playerName);
    const cleanText = this._sanitizeAnswer(text);

    if (!cleanPlayerId || !cleanText) return;
    if (!this.responders.some((r) => r.id === cleanPlayerId)) return;

    this.answers.set(cleanPlayerId, {
      text: cleanText,
      playerName: cleanPlayerName || this._playerName(cleanPlayerId),
      timestamp: Date.now(),
    });

    if (this.ui && typeof this.ui.onAnswerReceived === "function") {
      this.ui.onAnswerReceived(
        cleanPlayerId,
        cleanPlayerName || this._playerName(cleanPlayerId),
        cleanText,
        this._getResponseProgress(),
      );
    }

    this._syncSnapshot();

    if (this._allRespondersAccountedFor()) {
      this.evaluateAnswers();
    }
  }

  /**
   * @param {string} playerId
   */
  receiveSkip(playerId) {
    if (!this._amRoundAuthority()) return;

    const cleanPlayerId = this._sanitizePeerId(playerId);
    if (!cleanPlayerId) return;
    if (!this.responders.some((r) => r.id === cleanPlayerId)) return;

    this.skips.add(cleanPlayerId);

    if (this.ui && typeof this.ui.onSkipReceived === "function") {
      this.ui.onSkipReceived(
        cleanPlayerId,
        this._playerName(cleanPlayerId),
        this._getResponseProgress(),
      );
    }

    this._syncSnapshot();

    if (this._allRespondersAccountedFor()) {
      this.evaluateAnswers();
    }
  }

  // ===========================================================================
  // AI Evaluation — QUESTIONER OWNED
  // ===========================================================================

  async evaluateAnswers() {
    if (!this._amRoundAuthority()) {
      console.warn(
        "[Game] evaluateAnswers() ignored because we are not round authority.",
      );
      return;
    }

    if (this._evaluating) return;

    this._evaluating = true;
    this.roundState = "validating";
    this._syncSnapshot();

    if (this.ui && typeof this.ui.onValidating === "function") {
      this.ui.onValidating();
    }

    let winnerId = null;
    let winnerName = null;
    let aiReason = "";
    const validations = {};

    try {
      if (this.answers.size === 0) {
        aiReason = "All responders skipped — no winner this round.";
      } else if (this.answers.size === 1) {
        const [onlyId, answer] = [...this.answers.entries()][0];
        validations[onlyId] = await this._safeValidate(
          this.currentQuestion,
          answer.text,
        );

        if (validations[onlyId].valid) {
          winnerId = onlyId;
          winnerName = answer.playerName;
          aiReason = "Only valid answer submitted.";
        } else {
          aiReason = `The only answer was invalid: ${validations[onlyId].reason || "Unknown reason"}.`;
        }
      } else {
        const entries = [...this.answers.entries()].slice(0, 2);
        const [id1, answer1] = entries[0];
        const [id2, answer2] = entries[1];

        const [val1, val2] = await Promise.all([
          this._safeValidate(this.currentQuestion, answer1.text),
          this._safeValidate(this.currentQuestion, answer2.text),
        ]);

        validations[id1] = val1;
        validations[id2] = val2;

        if (val1.valid && val2.valid) {
          try {
            const result = await this.ai.pickBestAnswer(
              this.currentQuestion,
              answer1.text,
              answer2.text,
            );

            if (result && result.winner === "B") {
              winnerId = id2;
              winnerName = answer2.playerName;
            } else {
              winnerId = id1;
              winnerName = answer1.playerName;
            }

            aiReason = this._sanitizeText(
              result && result.reason
                ? result.reason
                : "AI selected the better answer.",
              400,
            );
          } catch (_) {
            winnerId = id1;
            winnerName = answer1.playerName;
            aiReason = "AI comparison failed — first answer wins by default.";
          }
        } else if (val1.valid) {
          winnerId = id1;
          winnerName = answer1.playerName;
          aiReason = `${answer2.playerName}'s answer was invalid${val2.reason ? ` (${val2.reason})` : ""}.`;
        } else if (val2.valid) {
          winnerId = id2;
          winnerName = answer2.playerName;
          aiReason = `${answer1.playerName}'s answer was invalid${val1.reason ? ` (${val1.reason})` : ""}.`;
        } else {
          aiReason = "Both answers were invalid — no winner this round.";
        }
      }
    } catch (err) {
      console.error("[Game] Error while evaluating answers:", err);
      aiReason = "An error occurred during evaluation — no winner this round.";
    }

    if (winnerId) {
      this.scores.set(winnerId, (this.scores.get(winnerId) || 0) + 1);
    }

    this.lastValidations = validations;
    this.lastResultReason = aiReason;
    this.lastRoundEndedAt = Date.now();
    this.roundState = "results";
    this.state = "round-end";
    this._evaluating = false;

    const serializedAnswers = {};
    for (const [pid, ans] of this.answers.entries()) {
      serializedAnswers[pid] = {
        text: ans.text,
        playerName: ans.playerName,
      };
    }

    const resultMsg = {
      type: "round-result",
      roundNum: this.currentRound,
      question: this.currentQuestion,
      wikiUrl: this.currentWikiUrl,
      winner: winnerId,
      winnerName,
      reason: aiReason,
      validations,
      answers: serializedAnswers,
      skips: [...this.skips],
      scores: Object.fromEntries(this.scores),
      roundAuthorityId: this.roundAuthorityId,
    };

    this.network.broadcast(resultMsg);
    this.handleMessage(resultMsg);
    this._syncSnapshot();
  }

  /**
   * @param {string} question
   * @param {string} answerText
   * @returns {Promise<{valid: boolean, reason: string}>}
   */
  async _safeValidate(question, answerText) {
    try {
      const result = await this.ai.validateAnswer(question, answerText);
      return {
        valid: !!(result && result.valid),
        reason: this._sanitizeText(
          result && result.reason ? result.reason : "",
          250,
        ),
      };
    } catch (_) {
      return {
        valid: true,
        reason: "AI validation failed — allowing answer.",
      };
    }
  }

  // ===========================================================================
  // Results / Recovery
  // ===========================================================================

  /**
   * @param {Object} msg
   */
  _handleRoundResult(msg) {
    this.roundState = "results";
    this.state = "round-end";
    this.stopTimer();
    this._evaluating = false;
    this._recovering = false;

    if (msg.scores && typeof msg.scores === "object") {
      this.scores = new Map();
      for (const [id, score] of Object.entries(msg.scores)) {
        const cleanId = this._sanitizePeerId(id);
        if (!cleanId) continue;
        this.scores.set(cleanId, this._sanitizeScore(score));
      }
    }

    const answers =
      msg.answers && typeof msg.answers === "object" ? msg.answers : {};

    const validations =
      msg.validations && typeof msg.validations === "object"
        ? msg.validations
        : {};

    this.lastValidations = validations;
    this.lastResultReason = this._sanitizeText(msg.reason, 400);
    this.lastRoundEndedAt = Date.now();

    if (this.ui && typeof this.ui.onRoundResult === "function") {
      this.ui.onRoundResult({
        roundNum:
          typeof msg.roundNum === "number" ? msg.roundNum : this.currentRound,
        question: this._sanitizeQuestion(msg.question),
        wikiUrl: this._sanitizeWikiUrl(msg.wikiUrl),
        winner: this._sanitizePeerId(msg.winner),
        winnerName: this._sanitizeName(msg.winnerName),
        reason: this.lastResultReason,
        answers,
        skips: Array.isArray(msg.skips) ? msg.skips : [],
        validations,
        scores: this.scores,
        isHost:
          this.network && this.network.isHost ? this.network.isHost() : false,
      });
    }

    this._syncSnapshot();
  }

  /**
   * @param {Object} msg
   */
  _handleRequestNewAnswers(msg) {
    if (this.getMyRole() !== "responder") return;

    this.roundState = "waiting-answers";
    this.startTimer();

    if (this.ui && typeof this.ui.onRequestNewAnswers === "function") {
      this.ui.onRequestNewAnswers(
        this._sanitizeText(msg.reason, 180) || "Try answering again.",
      );
    }

    this._syncSnapshot();
  }

  nextRound() {
    if (!this.network || !this.network.isHost || !this.network.isHost()) return;
    this.questionerIndex += 1;
    this.startRound();
  }

  // ===========================================================================
  // Timer
  // ===========================================================================

  startTimer() {
    this.stopTimer();
    this.timeLeft = 60;

    if (this.ui && typeof this.ui.onTimerUpdate === "function") {
      this.ui.onTimerUpdate(this.timeLeft, false);
    }

    this.timer = setInterval(() => {
      this.timeLeft -= 1;

      if (this.ui && typeof this.ui.onTimerUpdate === "function") {
        this.ui.onTimerUpdate(this.timeLeft, this.timeLeft <= 10);
      }

      if (this.timeLeft <= 0) {
        this.stopTimer();
        this.skipAnswer();
      }
    }, 1000);
  }

  stopTimer() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ===========================================================================
  // Migration / Recovery
  // ===========================================================================

  /**
   * @param {Object} info
   */
  _onHostMigrationStarted(info) {
    this._recovering = true;
    this._notify("Host migrating… reconnecting room authority.", "info");
  }

  /**
   * @param {Object} info
   */
  _onHostChanged(info) {
    this._recovering = false;

    // After a host change, refresh from the room snapshot if available.
    const snapshot =
      this.network && this.network.getRoomSnapshot
        ? this.network.getRoomSnapshot()
        : null;

    if (snapshot && snapshot.gameState) {
      this._hydrateFromSnapshot(snapshot.gameState);
    }

    this._notify("Connection recovered after host migration.", "success");
  }

  /**
   * @param {{id: string, name: string}} info
   */
  _onPlayerLeft(info) {
    if (this.state === "lobby") return;

    const playerId = this._sanitizePeerId(info && info.id);
    if (!playerId) return;

    const idx = this.playerOrder.findIndex((p) => p.id === playerId);
    if (idx !== -1) {
      this.playerOrder.splice(idx, 1);
      if (this.questionerIndex > idx) {
        this.questionerIndex -= 1;
      }
      if (this.playerOrder.length > 0) {
        this.questionerIndex = this.questionerIndex % this.playerOrder.length;
      }
    }

    this.responders = this.responders.filter((r) => r.id !== playerId);

    if (!this.answers.has(playerId)) {
      this.skips.add(playerId);
    }

    if (!this.network || !this.network.isHost || !this.network.isHost()) {
      this._syncSnapshot();
      return;
    }

    if (this.playerOrder.length < 3) {
      this.endGame("Not enough players remaining (need at least 3).");
      return;
    }

    if (this.questioner && this.questioner.id === playerId) {
      this.startRound();
      return;
    }

    if (
      this.roundState === "waiting-answers" &&
      this._amRoundAuthority() &&
      this._allRespondersAccountedFor()
    ) {
      this.evaluateAnswers();
    }

    this._syncSnapshot();
  }

  /**
   * @param {Object} gameState
   */
  _hydrateFromSnapshot(gameState) {
    if (!gameState || typeof gameState !== "object") return;

    this.state =
      gameState.state === "playing" || gameState.state === "round-end"
        ? gameState.state
        : "lobby";

    this.roundState =
      gameState.roundState === "asking" ||
      gameState.roundState === "waiting-answers" ||
      gameState.roundState === "validating" ||
      gameState.roundState === "results"
        ? gameState.roundState
        : null;

    this.currentRound =
      typeof gameState.currentRound === "number"
        ? Math.max(0, gameState.currentRound)
        : this.currentRound;

    this.questionerIndex =
      typeof gameState.questionerIndex === "number"
        ? Math.max(0, gameState.questionerIndex)
        : this.questionerIndex;

    this.questioner =
      gameState.questioner && gameState.questioner.id
        ? {
            id: this._sanitizePeerId(gameState.questioner.id),
            name: this._sanitizeName(gameState.questioner.name),
          }
        : this.questioner;

    this.responders = Array.isArray(gameState.responders)
      ? gameState.responders
          .map((r) => ({
            id: this._sanitizePeerId(r.id),
            name: this._sanitizeName(r.name),
          }))
          .filter((r) => r.id)
      : this.responders;

    this.playerOrder = Array.isArray(gameState.playerOrder)
      ? gameState.playerOrder
          .map((p) => ({
            id: this._sanitizePeerId(p.id),
            name: this._sanitizeName(p.name),
          }))
          .filter((p) => p.id)
      : this.playerOrder;

    this.currentQuestion =
      this._sanitizeQuestion(gameState.currentQuestion) || this.currentQuestion;
    this.currentWikiUrl =
      this._sanitizeWikiUrl(gameState.currentWikiUrl) || this.currentWikiUrl;

    this.roundAuthorityId =
      this._sanitizePeerId(gameState.roundAuthorityId) ||
      this.roundAuthorityId ||
      (this.questioner ? this.questioner.id : null);

    if (gameState.scores && typeof gameState.scores === "object") {
      this.scores = new Map();
      for (const [id, score] of Object.entries(gameState.scores)) {
        const cleanId = this._sanitizePeerId(id);
        if (!cleanId) continue;
        this.scores.set(cleanId, this._sanitizeScore(score));
      }
    }

    this.answers = new Map();
    if (gameState.answers && typeof gameState.answers === "object") {
      for (const [id, value] of Object.entries(gameState.answers)) {
        const cleanId = this._sanitizePeerId(id);
        if (!cleanId || !value || typeof value !== "object") continue;

        const cleanText = this._sanitizeAnswer(value.text);
        if (!cleanText) continue;

        this.answers.set(cleanId, {
          text: cleanText,
          playerName:
            this._sanitizeName(value.playerName) || this._playerName(cleanId),
          timestamp:
            typeof value.timestamp === "number" ? value.timestamp : Date.now(),
        });
      }
    }

    this.skips = new Set(
      Array.isArray(gameState.skips)
        ? gameState.skips.map((id) => this._sanitizePeerId(id)).filter(Boolean)
        : [],
    );

    this.lastValidations =
      gameState.lastValidations && typeof gameState.lastValidations === "object"
        ? gameState.lastValidations
        : this.lastValidations;

    this.lastResultReason =
      this._sanitizeText(gameState.lastResultReason, 400) ||
      this.lastResultReason;

    this.lastRoundEndedAt =
      typeof gameState.lastRoundEndedAt === "number"
        ? gameState.lastRoundEndedAt
        : this.lastRoundEndedAt;
  }

  // ===========================================================================
  // Snapshot Sync
  // ===========================================================================

  _syncSnapshot() {
    if (!this.network || typeof this.network.updateGameState !== "function") {
      return;
    }

    const serializedAnswers = {};
    for (const [id, answer] of this.answers.entries()) {
      serializedAnswers[id] = {
        text: answer.text,
        playerName: answer.playerName,
        timestamp: answer.timestamp,
      };
    }

    this.network.updateGameState({
      state: this.state,
      roundState: this.roundState,
      currentRound: this.currentRound,
      questionerIndex: this.questionerIndex,
      questioner: this.questioner,
      responders: this.responders,
      playerOrder: this.playerOrder,
      currentQuestion: this.currentQuestion,
      currentWikiUrl: this.currentWikiUrl,
      answers: serializedAnswers,
      skips: [...this.skips],
      scores: Object.fromEntries(this.scores),
      roundAuthorityId: this.roundAuthorityId,
      lastValidations: this.lastValidations,
      lastResultReason: this.lastResultReason,
      lastRoundEndedAt: this.lastRoundEndedAt,
    });
  }

  // ===========================================================================
  // Accessors
  // ===========================================================================

  getScores() {
    const result = [];
    for (const player of this.playerOrder) {
      result.push({
        id: player.id,
        name: player.name,
        score: this.scores.get(player.id) || 0,
      });
    }
    result.sort((a, b) => b.score - a.score);
    return result;
  }

  getMyRole() {
    const myId = this._myId();

    if (this.questioner && this.questioner.id === myId) {
      return "questioner";
    }

    if (this.responders.some((r) => r.id === myId)) {
      return "responder";
    }

    return "spectator";
  }

  isMyTurnToAsk() {
    return this.getMyRole() === "questioner";
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  cleanup() {
    this.stopTimer();

    this.state = "lobby";
    this.roundState = null;
    this.currentRound = 0;
    this.questionerIndex = 0;
    this.questioner = null;
    this.responders = [];
    this.playerOrder = [];
    this.currentQuestion = null;
    this.currentWikiUrl = null;
    this.answers = new Map();
    this.skips = new Set();
    this.scores = new Map();
    this._evaluating = false;
    this._recovering = false;
    this.roundAuthorityId = null;
    this.lastValidations = {};
    this.lastResultReason = null;
    this.lastRoundEndedAt = null;

    if (this.network && this._boundMessageHandler) {
      this.network.off("message", this._boundMessageHandler);
    }
    if (this.network && this._boundPlayerLeftHandler) {
      this.network.off("player-left", this._boundPlayerLeftHandler);
    }
    if (this.network && this._boundHostChangedHandler) {
      this.network.off("host-changed", this._boundHostChangedHandler);
    }
    if (this.network && this._boundHostMigrationStartedHandler) {
      this.network.off(
        "host-migration-started",
        this._boundHostMigrationStartedHandler,
      );
    }

    this._boundMessageHandler = null;
    this._boundPlayerLeftHandler = null;
    this._boundHostChangedHandler = null;
    this._boundHostMigrationStartedHandler = null;
  }

  // ===========================================================================
  // Internal helpers
  // ===========================================================================

  _allRespondersAccountedFor() {
    for (const responder of this.responders) {
      if (!this.answers.has(responder.id) && !this.skips.has(responder.id)) {
        return false;
      }
    }
    return true;
  }

  _getResponseProgress() {
    return {
      answered: this.answers.size,
      skipped: this.skips.size,
      total: this.responders.length,
    };
  }

  _getCanonicalPlayers() {
    if (!this.network || typeof this.network.getPlayers !== "function")
      return [];
    const players = this.network.getPlayers();
    if (!Array.isArray(players)) return [];

    return players
      .map((p) => ({
        id: this._sanitizePeerId(p.id),
        name: this._sanitizeName(p.name),
      }))
      .filter((p) => p.id);
  }

  _refreshPlayerOrderFromNetwork() {
    const currentScores = new Map(this.scores);
    const players = this._getCanonicalPlayers();

    const existingOrder = this.playerOrder.map((p) => p.id);
    const nextPlayers = [];

    for (const id of existingOrder) {
      const found = players.find((p) => p.id === id);
      if (found) nextPlayers.push(found);
    }

    for (const p of players) {
      if (!nextPlayers.some((np) => np.id === p.id)) {
        nextPlayers.push(p);
      }
    }

    this.playerOrder = nextPlayers;

    for (const p of this.playerOrder) {
      if (!currentScores.has(p.id)) {
        currentScores.set(p.id, 0);
      }
    }

    this.scores = new Map();
    for (const p of this.playerOrder) {
      this.scores.set(p.id, currentScores.get(p.id) || 0);
    }
  }

  _playerName(playerId) {
    const cleanId = this._sanitizePeerId(playerId);
    if (!cleanId) return "Player";

    const inOrder = this.playerOrder.find((p) => p.id === cleanId);
    if (inOrder) return inOrder.name;

    const fromQuestioner =
      this.questioner && this.questioner.id === cleanId
        ? this.questioner.name
        : null;
    if (fromQuestioner) return fromQuestioner;

    const responder = this.responders.find((r) => r.id === cleanId);
    if (responder) return responder.name;

    return "Player";
  }

  _isPlayerActive(playerId) {
    const cleanId = this._sanitizePeerId(playerId);
    if (!cleanId) return false;

    return this._getCanonicalPlayers().some((p) => p.id === cleanId);
  }

  _amRoundAuthority() {
    return !!this.roundAuthorityId && this.roundAuthorityId === this._myId();
  }

  _myId() {
    return this.network && typeof this.network.getMyId === "function"
      ? this.network.getMyId()
      : null;
  }

  _myName() {
    return this.network && typeof this.network.getMyName === "function"
      ? this._sanitizeName(this.network.getMyName())
      : "Player";
  }

  _sanitizeName(value) {
    if (typeof value !== "string") return "";
    let text = value
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (text.length > this.MAX_NAME_LENGTH) {
      text = text.slice(0, this.MAX_NAME_LENGTH).trim();
    }

    return text;
  }

  _sanitizeQuestion(value) {
    return this._sanitizeText(value, this.MAX_QUESTION_LENGTH);
  }

  _sanitizeAnswer(value) {
    return this._sanitizeText(value, this.MAX_ANSWER_LENGTH);
  }

  _sanitizeText(value, maxLength = 1000) {
    if (typeof value !== "string") return "";
    let text = value
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .trim();

    if (text.length > maxLength) {
      text = text.slice(0, maxLength);
    }

    return text;
  }

  _sanitizePeerId(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!/^yhb-[0-9a-f]{16}$/.test(text)) return null;
    return text;
  }

  _sanitizeScore(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.floor(num));
  }

  _sanitizeWikiUrl(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text) return null;

    if (
      /^https:\/\/([a-z]{2,}\.)?wikipedia\.org\/wiki\//i.test(text) ||
      /^https:\/\/en\.wikipedia\.org\/wiki\/Special:Search\//i.test(text)
    ) {
      return text;
    }

    return null;
  }

  _notify(text, type = "info") {
    if (this.ui && typeof this.ui.showNotification === "function" && text) {
      this.ui.showNotification(this._sanitizeText(text, 180), type);
    }
  }
}

window.GameManager = GameManager;
