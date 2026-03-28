/**
 * YourAIHateBores.me — UI Manager
 * ================================
 * Handles all DOM manipulation, screen transitions, toast notifications,
 * modal management, and user-facing updates. All UI logic is centralised
 * here so the rest of the application can stay DOM-agnostic.
 *
 * Exposes: window.UIManager
 */

/* eslint-disable no-console */

class UIManager {
  constructor() {
    /** @type {string} Currently visible screen id */
    this.currentScreen = "screen-lobby";

    /** @type {Object<string, Function[]>} Simple event-emitter registry */
    this.listeners = {};

    /** @type {number|null} Active toast auto-dismiss timeout */
    this.toastTimeout = null;

    /** @type {string|null} Currently selected model id in the AI modal */
    this.selectedModelId = null;

    /**
     * Internal game state tracked by the UI so bridge methods can
     * transform data formats and route to the correct screens.
     */
    this._gameState = {
      roundNum: 0,
      questionText: null,
      wikiUrl: null,
      myRole: null,
      players: [], // [{id, name}]
      questioner: null,
      responders: [],
      answerCount: 0,
    };

    // Cache frequently accessed DOM elements
    this.cacheElements();

    console.log("[UI] UIManager initialised");
  }

  // ---------------------------------------------------------------------------
  // DOM Element Caching
  // ---------------------------------------------------------------------------

  /**
   * Query and cache every DOM element we will touch more than once.
   * Grouped by screen / feature for readability.
   */
  cacheElements() {
    // -- All screens ----------------------------------------------------------
    this.screens = document.querySelectorAll(".screen");

    // -- Lobby screen ---------------------------------------------------------
    this.elLobbyRoomCode = document.getElementById("lobby-room-code");
    this.elBtnCopyRoomCode = document.getElementById("btn-copy-room-code");
    this.elLobbyPlayers = document.getElementById("lobby-players");
    this.elBtnStartGame = document.getElementById("btn-start-game");
    this.elAIStatus = document.getElementById("ai-status-indicator");
    this.elPlayerCount = document.getElementById("lobby-player-count");
    this.elBtnOpenAI = document.getElementById("btn-open-ai-settings");

    // -- Questioner screen ----------------------------------------------------
    this.elQuestionInput = document.getElementById("question-input");
    this.elBtnSubmitQuestion = document.getElementById("btn-submit-question");
    this.elQuestionerWaiting = document.getElementById(
      "questioner-waiting-phase",
    );
    this.elQuestionerInputPhase = document.getElementById(
      "questioner-input-phase",
    );
    this.elAnswersContainer = document.getElementById("answers-container");
    this.elQuestionerAnswers = document.getElementById(
      "questioner-answers-phase",
    );
    this.elQuestionerValidating = document.getElementById(
      "questioner-validating",
    );
    this.elQuestionerResults = document.getElementById("questioner-results");
    this.elQuestionerWinnerDisp = document.getElementById(
      "questioner-winner-display",
    );
    this.elQuestionerRound = document.getElementById(
      "questioner-round-counter",
    );

    // -- Responder screen -----------------------------------------------------
    this.elResponderQuestion = document.getElementById("responder-question");
    this.elWikiContainer = document.getElementById("wiki-container");
    this.elWikiIframe = document.getElementById("wiki-iframe");
    this.elBtnToggleWiki = document.getElementById("btn-toggle-wiki");
    this.elWikiIframeWrapper = document.getElementById("wiki-iframe-wrapper");
    this.elTimerDisplay = document.getElementById("timer-display");
    this.elAnswerInput = document.getElementById("answer-input");
    this.elBtnSubmitAnswer = document.getElementById("btn-submit-answer");
    this.elBtnSkipAnswer = document.getElementById("btn-skip-answer");
    this.elResponderStatus = document.getElementById("responder-status");
    this.elResponderRound = document.getElementById("responder-round-counter");

    // -- Waiting screen -------------------------------------------------------
    this.elWaitingQuestioner = document.getElementById(
      "waiting-questioner-name",
    );
    this.elWaitingScoreboard = document.getElementById("waiting-scoreboard");

    // -- Results screen -------------------------------------------------------
    this.elResultsQuestionText = document.getElementById(
      "results-question-text",
    );
    this.elResultsAnswersList = document.getElementById("results-answers-list");
    this.elResultsReasoning = document.getElementById("results-reasoning-text");
    this.elResultsScoreUpdate = document.getElementById(
      "results-score-update-list",
    );
    this.elResultsScoreboard = document.getElementById("results-scoreboard");
    this.elBtnNextRound = document.getElementById("btn-next-round");

    // -- AI Settings Modal ----------------------------------------------------
    this.elModal = document.getElementById("modal-ai-settings");
    this.elModalOverlay = this.elModal
      ? this.elModal.querySelector(".modal-overlay")
      : null;
    this.elProviderCards = this.elModal
      ? this.elModal.querySelectorAll(".provider-option")
      : [];
    this.elProviderOpenRouter = document.getElementById("provider-openrouter");
    this.elProviderCompat = document.getElementById(
      "provider-openai-compatible",
    );
    this.elApiKeyInput = document.getElementById("ai-api-key");
    this.elBaseUrlInput = document.getElementById("ai-base-url");
    this.elBaseUrlGroup = document.getElementById("base-url-group");
    this.elBtnFetchModels = document.getElementById("btn-fetch-models");
    this.elModelSearchInput = document.getElementById("model-search-input");
    this.elModelList = document.getElementById("model-list");
    this.elBtnSaveAI = document.getElementById("btn-save-ai-settings");
    this.elModalStatus = document.getElementById("ai-settings-status");
    this.elBtnCloseAI = document.getElementById("btn-close-ai-settings");

    // -- Toast container ------------------------------------------------------
    this.elToastContainer = document.getElementById("toast-container");

    // -- Connection status ----------------------------------------------------
    this.elConnectionStatus = document.getElementById("connection-status");

    console.log("[UI] DOM elements cached");
  }

  // ---------------------------------------------------------------------------
  // Simple Event Emitter
  // ---------------------------------------------------------------------------

  /**
   * Register a listener for a UI event.
   * @param {string}   event    Event name
   * @param {Function} callback Handler function
   */
  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  /**
   * Emit a UI event, calling all registered listeners.
   * @param {string} event Event name
   * @param {...*}   args  Arguments forwarded to listeners
   */
  emit(event, ...args) {
    const callbacks = this.listeners[event];
    if (callbacks && callbacks.length) {
      callbacks.forEach((cb) => {
        try {
          cb(...args);
        } catch (err) {
          console.error(`[UI] Error in listener for "${event}":`, err);
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Event Listener Binding
  // ---------------------------------------------------------------------------

  /**
   * Bind every interactive DOM element to the appropriate handler / emitted event.
   * Should be called once after construction.
   */
  initEventListeners() {
    // -- Lobby: Start Game ----------------------------------------------------
    if (this.elBtnStartGame) {
      this.elBtnStartGame.addEventListener("click", () => {
        this.emit("start-game");
      });
    }

    // -- Questioner: Submit Question ------------------------------------------
    if (this.elBtnSubmitQuestion) {
      this.elBtnSubmitQuestion.addEventListener("click", () => {
        this._handleSubmitQuestion();
      });
    }

    // -- Responder: Submit Answer ---------------------------------------------
    if (this.elBtnSubmitAnswer) {
      this.elBtnSubmitAnswer.addEventListener("click", () => {
        this._handleSubmitAnswer();
      });
    }

    // -- Responder: Skip Answer -----------------------------------------------
    if (this.elBtnSkipAnswer) {
      this.elBtnSkipAnswer.addEventListener("click", () => {
        this.emit("skip-answer");
        this.disableAnswerControls();
      });
    }

    // -- Results: Next Round --------------------------------------------------
    if (this.elBtnNextRound) {
      this.elBtnNextRound.addEventListener("click", () => {
        this.emit("next-round");
      });
    }

    // -- Lobby: Open AI Settings Modal ----------------------------------------
    if (this.elBtnOpenAI) {
      this.elBtnOpenAI.addEventListener("click", () => {
        this.emit("open-ai-settings");
      });
    }

    // -- Modal: Close button --------------------------------------------------
    if (this.elBtnCloseAI) {
      this.elBtnCloseAI.addEventListener("click", () => {
        this.hideAISettingsModal();
      });
    }

    // -- Modal: Click overlay to close ----------------------------------------
    if (this.elModalOverlay) {
      this.elModalOverlay.addEventListener("click", () => {
        this.hideAISettingsModal();
      });
    }

    // -- Modal: Provider card selection ---------------------------------------
    if (this.elProviderCards && this.elProviderCards.length) {
      this.elProviderCards.forEach((option) => {
        option.addEventListener("click", () => {
          // The radio input inside the label handles checked state automatically.
          // We just need to show/hide the base URL group.
          this._syncBaseUrlVisibility();
        });

        // Also listen to the radio change event for keyboard users
        const radio = option.querySelector('input[type="radio"]');
        if (radio) {
          radio.addEventListener("change", () => {
            this._syncBaseUrlVisibility();
          });
        }
      });
    }

    // -- Modal: Fetch Models --------------------------------------------------
    if (this.elBtnFetchModels) {
      this.elBtnFetchModels.addEventListener("click", () => {
        this.emit("fetch-models");
      });
    }

    // -- Modal: Save Settings -------------------------------------------------
    if (this.elBtnSaveAI) {
      this.elBtnSaveAI.addEventListener("click", () => {
        this._handleSaveAISettings();
      });
    }

    // -- Lobby: Copy room code ------------------------------------------------
    if (this.elBtnCopyRoomCode) {
      this.elBtnCopyRoomCode.addEventListener("click", () => {
        this._copyRoomCode();
      });
    }

    // -- Responder: Wiki toggle -----------------------------------------------
    if (this.elBtnToggleWiki) {
      this.elBtnToggleWiki.addEventListener("click", () => {
        if (this.elWikiIframeWrapper) {
          this.elWikiIframeWrapper.classList.toggle("hidden");
        }
      });
    }

    // -- Modal: Model search --------------------------------------------------
    if (this.elModelSearchInput) {
      this.elModelSearchInput.addEventListener("input", () => {
        this.filterModelList(this.elModelSearchInput.value);
      });
    }

    // -- Keyboard: Enter key shortcuts ----------------------------------------
    this._bindEnterKey(this.elQuestionInput, () => {
      this._handleSubmitQuestion();
    });

    this._bindEnterKey(this.elAnswerInput, () => {
      this._handleSubmitAnswer();
    });

    console.log("[UI] Event listeners initialised");
  }

  // ---------------------------------------------------------------------------
  // Internal Handler Helpers
  // ---------------------------------------------------------------------------

  /** Handle question submission. */
  _handleSubmitQuestion() {
    if (!this.elQuestionInput || !this.elBtnSubmitQuestion) return;
    const text = this._sanitizeInput(this.elQuestionInput.value, 500, true);
    if (!text) {
      this.showNotification("Please enter a valid question.", "warning");
      this.elQuestionInput.focus();
      return;
    }
    this.elQuestionInput.value = text;
    this.elBtnSubmitQuestion.disabled = true;
    this.emit("submit-question", text);
  }

  /** Handle answer submission. */
  _handleSubmitAnswer() {
    if (!this.elAnswerInput || !this.elBtnSubmitAnswer) return;
    const text = this._sanitizeInput(this.elAnswerInput.value, 1000, true);
    if (!text) {
      this.showNotification("Please enter a valid answer.", "warning");
      this.elAnswerInput.focus();
      return;
    }
    this.elAnswerInput.value = text;
    this.elBtnSubmitAnswer.disabled = true;
    this.emit("submit-answer", text);
  }

  /** Validate and emit save-ai-settings from the modal. */
  _handleSaveAISettings() {
    const provider = this.getSelectedProvider();
    const apiKey = this.elApiKeyInput
      ? this._sanitizeInput(this.elApiKeyInput.value, 300, false)
      : "";
    const baseUrl = this.elBaseUrlInput
      ? this._sanitizeInput(this.elBaseUrlInput.value, 300, false)
      : "";
    const model = this.getSelectedModel();

    if (!apiKey) {
      this.setModalStatus("API key is required.", "error");
      return;
    }
    if (provider === "openai-compatible" && !baseUrl) {
      this.setModalStatus(
        "Base URL is required for OpenAI-compatible providers.",
        "error",
      );
      return;
    }
    if (!model) {
      this.setModalStatus("Please select a model.", "error");
      return;
    }

    if (this.elApiKeyInput) {
      this.elApiKeyInput.value = apiKey;
    }
    if (this.elBaseUrlInput) {
      this.elBaseUrlInput.value = baseUrl;
    }

    this.emit("save-ai-settings", { provider, apiKey, baseUrl, model });
  }

  /** Copy the lobby room code to clipboard with brief visual feedback. */
  async _copyRoomCode() {
    if (!this.elLobbyRoomCode) return;
    const code = this.elLobbyRoomCode.textContent.trim();
    if (!code || code === "------") return;

    try {
      await navigator.clipboard.writeText(code);
      // Brief "Copied!" feedback on the button
      if (this.elBtnCopyRoomCode) {
        const original = this.elBtnCopyRoomCode.textContent;
        this.elBtnCopyRoomCode.textContent = "✅";
        setTimeout(() => {
          this.elBtnCopyRoomCode.textContent = original;
        }, 1500);
      }
    } catch (err) {
      console.warn("[UI] Clipboard write failed:", err);
      this.showNotification("Failed to copy room code.", "error");
    }
  }

  /** Show or hide the base URL input group depending on selected provider. */
  _syncBaseUrlVisibility() {
    const provider = this.getSelectedProvider();
    if (this.elBaseUrlGroup) {
      if (provider === "openai-compatible") {
        this.elBaseUrlGroup.classList.remove("hidden");
      } else {
        this.elBaseUrlGroup.classList.add("hidden");
      }
    }
  }

  /**
   * Bind the Enter key on a textarea/input to a callback.
   * For textareas we require Ctrl/Meta + Enter; for inputs plain Enter suffices.
   * @param {HTMLElement|null} el
   * @param {Function}         fn
   */
  _bindEnterKey(el, fn) {
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      // For textareas, require Ctrl/Cmd + Enter so the user can type newlines
      if (el.tagName === "TEXTAREA" && !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      fn();
    });
  }

  /**
   * Sanitize free-form user input for safe transport / display.
   * Removes control characters, trims whitespace, and enforces length limits.
   *
   * @param {string} value
   * @param {number} maxLength
   * @param {boolean} preserveNewlines
   * @returns {string}
   */
  _sanitizeInput(value, maxLength = 1000, preserveNewlines = false) {
    if (typeof value !== "string") return "";

    let text = preserveNewlines
      ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      : value.replace(/[\u0000-\u001F\u007F]/g, " ");

    if (preserveNewlines) {
      text = text
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n");
    } else {
      text = text.replace(/\s+/g, " ");
    }

    text = text.trim();

    if (text.length > maxLength) {
      text = text.slice(0, maxLength).trim();
    }

    return text;
  }

  /**
   * Sanitize room code input to the expected 6-char uppercase format.
   *
   * @param {string} value
   * @returns {string}
   */
  _sanitizeRoomCode(value) {
    if (typeof value !== "string") return "";
    return value
      .toUpperCase()
      .replace(/[^A-Z2-9]/g, "")
      .slice(0, 6);
  }

  // ---------------------------------------------------------------------------
  // Screen Transitions
  // ---------------------------------------------------------------------------

  /**
   * Transition to a screen by id.
   * Removes 'active' from all screens, adds it to the target.
   * @param {string} screenId  e.g. 'screen-lobby'
   */
  showScreen(screenId) {
    this.screens.forEach((s) => s.classList.remove("active"));

    const target = document.getElementById(screenId);
    if (target) {
      target.classList.add("active");
    } else {
      console.warn(`[UI] Screen "${screenId}" not found`);
    }

    this.currentScreen = screenId;

    // Scroll to top for a clean view
    window.scrollTo({ top: 0, behavior: "smooth" });

    console.log(`[UI] Screen → ${screenId}`);
  }

  /** Show the welcome / landing screen. */
  showWelcome() {
    this.showLobby("GLOBAL");
  }

  /**
   * Show the lobby screen and populate the room code.
   * @param {string} roomCode
   */
  showLobby(roomCode) {
    this.showScreen("screen-lobby");
    if (this.elLobbyRoomCode) {
      this.elLobbyRoomCode.textContent = roomCode;
    }
    this.updateConnectionStatus("connected");
  }

  // ---------------------------------------------------------------------------
  // Lobby Updates
  // ---------------------------------------------------------------------------

  /**
   * Rebuild the player list in the lobby.
   * @param {Array<{id:string, name:string, isHost:boolean}>} players
   * @param {string} myId  The local player's id
   */
  updatePlayerList(players, myId) {
    if (!this.elLobbyPlayers) return;

    // Clear existing cards
    this.elLobbyPlayers.innerHTML = "";

    players.forEach((player) => {
      const isMe = player.id === myId;
      const initial = player.name.charAt(0).toUpperCase();
      const bgColor = this.colorFromName(player.name);

      const card = document.createElement("div");
      card.className = "player-card";
      card.setAttribute("data-player-id", player.id);

      let badges = "";
      if (player.isHost) {
        badges += '<span class="badge badge-warning">👑 Host</span>';
      }
      if (isMe) {
        badges += '<span class="badge badge-primary">You</span>';
      }

      card.innerHTML = `
        <div class="player-avatar" style="background:${bgColor}">${escapeHtml(initial)}</div>
        <div class="player-info">
          <span class="player-name">${escapeHtml(player.name)}</span>
          ${badges}
        </div>
      `;

      this.elLobbyPlayers.appendChild(card);
    });

    // Update player count display
    if (this.elPlayerCount) {
      this.elPlayerCount.textContent = `${players.length} / 3+`;
    }

    console.log(`[UI] Player list updated (${players.length} players)`);
  }

  /**
   * Update the AI configuration status indicator in the lobby.
   * @param {boolean} configured
   */
  updateAIStatus(configured) {
    if (!this.elAIStatus) return;

    this.elAIStatus.setAttribute("data-configured", String(configured));

    const dot = this.elAIStatus.querySelector(".ai-status-dot");
    const text = this.elAIStatus.querySelector(".ai-status-text");

    if (configured) {
      this.elAIStatus.classList.add("configured");
      this.elAIStatus.classList.remove("not-configured");
      if (text) text.textContent = "✅ AI Ready";
    } else {
      this.elAIStatus.classList.remove("configured");
      this.elAIStatus.classList.add("not-configured");
      if (text) text.textContent = "⚠️ Configure AI";
    }
  }

  /**
   * Enable or disable the "Start Game" button and toggle visibility.
   * The button is always visible for the host (disabled until ready),
   * and always hidden for non-host players.
   * @param {boolean} canStart  true if isHost && players >= 3 && AI configured
   * @param {boolean} [isHost=false]  Whether the local player is the host
   */
  enableStartButton(canStart, isHost = false) {
    if (!this.elBtnStartGame) return;

    if (!isHost) {
      // Non-host players never see the start button
      this.elBtnStartGame.classList.add("hidden");
      return;
    }

    // Host always sees the button — enabled only when all conditions are met
    this.elBtnStartGame.classList.remove("hidden");
    this.elBtnStartGame.disabled = !canStart;
  }

  // ---------------------------------------------------------------------------
  // Questioner Screen
  // ---------------------------------------------------------------------------

  /**
   * Show the questioner (question-asking) screen.
   * @param {number} roundNum
   */
  showQuestionerScreen(roundNum) {
    this.showScreen("screen-questioner");

    // Update round counter
    if (this.elQuestionerRound) {
      this.elQuestionerRound.textContent = `Round ${roundNum}`;
    }

    // Reset UI state
    if (this.elQuestionInput) this.elQuestionInput.value = "";
    if (this.elBtnSubmitQuestion) this.elBtnSubmitQuestion.disabled = false;

    // Show input phase, hide waiting & answers phases
    if (this.elQuestionerInputPhase)
      this.elQuestionerInputPhase.classList.remove("hidden");
    if (this.elQuestionerWaiting)
      this.elQuestionerWaiting.classList.add("hidden");
    if (this.elQuestionerAnswers)
      this.elQuestionerAnswers.classList.add("hidden");
    if (this.elQuestionerValidating)
      this.elQuestionerValidating.classList.add("hidden");
    if (this.elQuestionerResults)
      this.elQuestionerResults.classList.add("hidden");

    // Clear previous answers
    if (this.elAnswersContainer) this.elAnswersContainer.innerHTML = "";
  }

  /**
   * Transition the questioner screen to "waiting for answers" state.
   */
  showQuestionerWaiting() {
    if (this.elQuestionerInputPhase)
      this.elQuestionerInputPhase.classList.add("hidden");
    if (this.elQuestionerWaiting)
      this.elQuestionerWaiting.classList.remove("hidden");
    if (this.elQuestionerAnswers)
      this.elQuestionerAnswers.classList.remove("hidden");
  }

  /**
   * Display that an answer was received from a player (shown on questioner screen).
   * @param {string} playerName
   * @param {number} answerNum   1-based answer index
   */
  showAnswerReceived(playerName, answerNum) {
    if (!this.elAnswersContainer) return;

    const card = document.createElement("div");
    card.className = "answer-card";
    card.innerHTML = `
      <span class="answer-player-name">${escapeHtml(playerName)}</span>
      <p class="answer-text">Answer #${answerNum} received ✓</p>
    `;
    this.elAnswersContainer.appendChild(card);
  }

  /**
   * Show "AI is validating…" state on the questioner screen.
   */
  showValidating() {
    if (this.elQuestionerWaiting)
      this.elQuestionerWaiting.classList.add("hidden");
    if (this.elQuestionerValidating)
      this.elQuestionerValidating.classList.remove("hidden");
  }

  // ---------------------------------------------------------------------------
  // Responder Screen
  // ---------------------------------------------------------------------------

  /**
   * Show the responder (answering) screen.
   * @param {number} roundNum
   * @param {string} questionText
   * @param {string} [wikiUrl]    Optional Wikipedia reference URL
   */
  showResponderScreen(roundNum, questionText, wikiUrl) {
    this.showScreen("screen-responder");

    // Round counter
    if (this.elResponderRound) {
      this.elResponderRound.textContent = `Round ${roundNum}`;
    }

    // Question text
    if (this.elResponderQuestion) {
      this.elResponderQuestion.innerHTML = `<p>${escapeHtml(questionText)}</p>`;
    }

    // Wikipedia iframe
    if (wikiUrl && this.elWikiIframe) {
      this.elWikiIframe.src = wikiUrl;
      if (this.elWikiContainer) this.elWikiContainer.classList.remove("hidden");
      // Hide the iframe wrapper by default until user toggles it
      if (this.elWikiIframeWrapper)
        this.elWikiIframeWrapper.classList.add("hidden");
    } else {
      if (this.elWikiContainer) this.elWikiContainer.classList.add("hidden");
    }

    // Enable controls
    if (this.elAnswerInput) {
      this.elAnswerInput.value = "";
      this.elAnswerInput.disabled = false;
    }
    if (this.elBtnSubmitAnswer) this.elBtnSubmitAnswer.disabled = false;
    if (this.elBtnSkipAnswer) this.elBtnSkipAnswer.disabled = false;

    // Clear status
    this.setResponderStatus("");
  }

  // ---------------------------------------------------------------------------
  // Waiting Screen
  // ---------------------------------------------------------------------------

  /**
   * Show the waiting screen while another player is the questioner.
   * @param {string} questionerName
   */
  showWaitingScreen(questionerName) {
    this.showScreen("screen-waiting");

    if (this.elWaitingQuestioner) {
      this.elWaitingQuestioner.textContent = questionerName;
    }
  }

  // ---------------------------------------------------------------------------
  // Timer
  // ---------------------------------------------------------------------------

  /**
   * Update the on-screen timer display.
   * @param {number} seconds  Remaining seconds
   */
  updateTimer(seconds) {
    if (!this.elTimerDisplay) return;

    const numberEl = this.elTimerDisplay.querySelector(".timer-number");
    if (numberEl) numberEl.textContent = seconds;

    this.elTimerDisplay.setAttribute("data-seconds", seconds);

    // Remove all state classes first
    this.elTimerDisplay.classList.remove(
      "timer-warning",
      "timer-danger",
      "pulse",
    );

    if (seconds <= 5) {
      this.elTimerDisplay.classList.add("timer-danger", "pulse");
    } else if (seconds <= 15) {
      this.elTimerDisplay.classList.add("timer-warning");
    }
    // > 15 → default / normal styling
  }

  // ---------------------------------------------------------------------------
  // Results Screen
  // ---------------------------------------------------------------------------

  /**
   * Display the round results.
   * @param {Object} data
   * @param {string}        data.question
   * @param {string}        data.winner      Winner player id
   * @param {string}        data.winnerName
   * @param {string}        data.reason      AI reasoning summary
   * @param {Array<Object>} data.answers     [{playerId, playerName, text, valid, validReason}]
   * @param {Object}        data.scores      {playerId: {name, score}}
   */
  showRoundResults(data) {
    this.showScreen("screen-results");

    const { question, winner, winnerName, reason, answers, scores } = data;

    // -- Question card --------------------------------------------------------
    if (this.elResultsQuestionText) {
      this.elResultsQuestionText.textContent = question;
    }

    // -- Answer cards ---------------------------------------------------------
    if (this.elResultsAnswersList) {
      this.elResultsAnswersList.innerHTML = "";

      answers.forEach((a) => {
        const isWinner = a.playerId === winner;
        const entry = document.createElement("div");
        entry.className = `results-answer-entry${isWinner ? " winner-card" : ""}`;
        entry.setAttribute("data-player-id", a.playerId);
        entry.setAttribute("data-winner", String(isWinner));

        let validationHtml = "";
        if (a.valid === false && a.validReason) {
          validationHtml = `<p class="validation-reason text-muted">❌ ${escapeHtml(a.validReason)}</p>`;
        } else if (a.valid === true) {
          validationHtml = `<p class="validation-reason text-muted">✅ Valid answer</p>`;
        }

        entry.innerHTML = `
          <span class="results-answer-player">${escapeHtml(a.playerName)}${isWinner ? " 🏆" : ""}</span>
          <p class="results-answer-text">${escapeHtml(a.text)}</p>
          ${validationHtml}
        `;

        this.elResultsAnswersList.appendChild(entry);
      });
    }

    // -- AI reasoning ---------------------------------------------------------
    if (this.elResultsReasoning) {
      this.elResultsReasoning.textContent = reason || "No reasoning provided.";
    }

    // -- Score update list ----------------------------------------------------
    if (this.elResultsScoreUpdate && scores) {
      this.elResultsScoreUpdate.innerHTML = "";

      const sorted = Object.entries(scores)
        .map(([id, info]) => ({ id, ...info }))
        .sort((a, b) => b.score - a.score);

      sorted.forEach((entry) => {
        const row = document.createElement("div");
        row.className = "score-entry";
        row.setAttribute("data-player-id", entry.id);

        const isWin = entry.id === winner;
        row.innerHTML = `
          <span class="score-player-name">${escapeHtml(entry.name)}${isWin ? " 🏆" : ""}</span>
          <span class="score-value">${entry.score}</span>
        `;
        this.elResultsScoreUpdate.appendChild(row);
      });
    }

    // -- Full scoreboard ------------------------------------------------------
    if (scores) {
      this.updateScoreboard(scores);
    }
  }

  /**
   * Render or re-render the scoreboard widget.
   * Can be used in both results screen and waiting screen.
   * @param {Object} scores  {playerId: {name, score}}
   */
  updateScoreboard(scores) {
    const targets = [this.elResultsScoreboard, this.elWaitingScoreboard];

    const sorted = Object.entries(scores)
      .map(([id, info]) => ({ id, ...info }))
      .sort((a, b) => b.score - a.score);

    targets.forEach((container) => {
      if (!container) return;
      container.innerHTML = "";

      sorted.forEach((entry, index) => {
        const rank = index + 1;
        const bgColor = this.colorFromName(entry.name);
        const initial = entry.name.charAt(0).toUpperCase();

        const row = document.createElement("div");
        row.className = `scoreboard-row${rank === 1 ? " top-player" : ""}`;
        row.setAttribute("data-player-id", entry.id);

        row.innerHTML = `
          <span class="rank">#${rank}</span>
          <div class="player-avatar" style="background:${bgColor}">${escapeHtml(initial)}</div>
          <span class="player-name">${escapeHtml(entry.name)}</span>
          <span class="score">${entry.score}</span>
        `;

        container.appendChild(row);
      });
    });
  }

  /**
   * Show or hide the "Next Round" button (host-only).
   * @param {boolean} isHost
   */
  showNextRoundButton(isHost) {
    if (!this.elBtnNextRound) return;
    if (isHost) {
      this.elBtnNextRound.classList.remove("hidden");
    } else {
      this.elBtnNextRound.classList.add("hidden");
    }
  }

  // ---------------------------------------------------------------------------
  // Game Callback Bridge Methods (called by GameManager)
  // ---------------------------------------------------------------------------
  // GameManager calls these on* methods to drive the UI. They translate
  // between the game's internal data formats and the show* / update*
  // methods defined elsewhere in this class.

  /**
   * Called when the game starts.  Store the player list for later name
   * lookups and show a notification.
   *
   * @param {Array<{id:string, name:string}>} players
   * @param {Map<string,number>}              scores
   */
  onGameStart(players, scores) {
    this._gameState.players = players || [];
    this.showNotification("Game started! 🎮", "success");
    console.log("[UI] onGameStart — players:", players.length);
  }

  /**
   * Called when the game ends (e.g. not enough players).
   *
   * @param {Array<{id:string, name:string, score:number}>} scores
   * @param {string} reason
   */
  onGameEnd(scores, reason) {
    this.showNotification(reason || "Game over!", "info", 6000);
    // Return to lobby after a brief pause so the user can read the toast
    setTimeout(() => this.showLobby("GLOBAL"), 2000);
    console.log("[UI] onGameEnd —", reason);
  }

  /**
   * Surface host migration status to players during room takeover.
   *
   * @param {Object} info
   * @param {string} info.previousHostId
   * @param {string} info.nextHostId
   */
  onHostMigrationStarted(info) {
    this.showNotification("Host changed — reconnecting room…", "warning", 5000);
    this.updateConnectionStatus("connecting");
    console.log("[UI] onHostMigrationStarted", info);
  }

  /**
   * Called when a new host is active and the room is healthy again.
   *
   * @param {Object} info
   * @param {string} info.currentHostId
   * @param {boolean} info.isMe
   */
  onHostChanged(info) {
    this.updateConnectionStatus("connected");
    this.showNotification(
      info && info.isMe
        ? "You became the host for this room."
        : "Room recovered with a new host.",
      "success",
      4500,
    );
    console.log("[UI] onHostChanged", info);
  }

  /**
   * Called at the start of every round.  Routes each player to the
   * correct screen based on their role.
   *
   * @param {Object}  data
   * @param {number}  data.roundNum
   * @param {{id:string, name:string}} data.questioner
   * @param {Array<{id:string, name:string}>} data.responders
   * @param {'questioner'|'responder'|'spectator'} data.myRole
   * @param {Map<string,number>} data.scores
   */
  onNewRound(data) {
    const { roundNum, questioner, responders, myRole, scores } = data;

    // Persist for later use by other bridge methods
    this._gameState.roundNum = roundNum;
    this._gameState.myRole = myRole;
    this._gameState.questioner = questioner;
    this._gameState.responders = responders;
    this._gameState.answerCount = 0;
    this._gameState.questionText = null;
    this._gameState.wikiUrl = null;

    switch (myRole) {
      case "questioner":
        this.showQuestionerScreen(roundNum);
        break;
      case "responder":
        // Responder starts in the waiting screen until the question arrives
        this.showWaitingScreen(questioner.name);
        break;
      case "spectator":
      default:
        this.showWaitingScreen(questioner.name);
        break;
    }

    // Update the waiting-screen scoreboard if we have scores
    if (scores) {
      this._updateScoreboardFromMap(scores);
    }

    console.log(`[UI] onNewRound ${roundNum} — role: ${myRole}`);
  }

  /**
   * Called on the questioner's browser after they submit a question.
   * Transitions to the "waiting for answers" state.
   *
   * @param {string} text  The question text
   */
  onQuestionSubmitted(text) {
    this._gameState.questionText = text;
    this.showQuestionerWaiting();
    console.log("[UI] onQuestionSubmitted");
  }

  /**
   * Called on a responder's browser when the question arrives.
   *
   * @param {Object} data
   * @param {string} data.text
   * @param {string} data.wikiUrl
   * @param {string} data.questionerName
   */
  onQuestionReceived(data) {
    this._gameState.questionText = data.text;
    this._gameState.wikiUrl = data.wikiUrl;
    this.showResponderScreen(this._gameState.roundNum, data.text, data.wikiUrl);
    console.log("[UI] onQuestionReceived");
  }

  /**
   * Called on a responder's browser after they submit their answer.
   */
  onAnswerSubmitted() {
    this.disableAnswerControls();
    this.setResponderStatus("Answer submitted! Waiting for results… ⏳");
    console.log("[UI] onAnswerSubmitted");
  }

  /**
   * Called on a responder's browser after they skip.
   */
  onAnswerSkipped() {
    this.disableAnswerControls();
    this.setResponderStatus("Skipped! Waiting for results… ⏳");
    console.log("[UI] onAnswerSkipped");
  }

  /**
   * Called on the questioner's browser when an answer is received from
   * a responder.
   *
   * @param {string} playerId
   * @param {string} playerName
   * @param {string} text
   * @param {{answered:number, skipped:number, total:number}} progress
   */
  onAnswerReceived(playerId, playerName, text, progress) {
    this._gameState.answerCount++;
    this.showAnswerReceived(playerName, this._gameState.answerCount);
    console.log(
      `[UI] onAnswerReceived from ${playerName} (${progress.answered}/${progress.total})`,
    );
  }

  /**
   * Called on the questioner's browser when a responder skips.
   *
   * @param {string} playerId
   * @param {string} name
   * @param {{answered:number, skipped:number, total:number}} progress
   */
  onSkipReceived(playerId, name, progress) {
    if (this.elAnswersContainer) {
      const card = document.createElement("div");
      card.className = "answer-card skipped";
      card.innerHTML = `
        <span class="answer-player-name">${escapeHtml(name)}</span>
        <p class="answer-text text-muted">⏭️ Skipped</p>
      `;
      this.elAnswersContainer.appendChild(card);
    }
    console.log(
      `[UI] onSkipReceived from ${name} (${progress.skipped} skips / ${progress.total} total)`,
    );
  }

  /**
   * Called on the questioner's browser when AI validation begins.
   */
  onValidating() {
    this.showValidating();
    console.log("[UI] onValidating");
  }

  /**
   * Called on every peer when round results are available.
   * Transforms the game's data format into what showRoundResults expects.
   *
   * @param {Object}  data
   * @param {number}  data.roundNum
   * @param {string}  data.question
   * @param {string|null}  data.winner       Winner player id
   * @param {string|null}  data.winnerName
   * @param {string}  data.reason            AI reasoning
   * @param {Object}  data.answers           {playerId: {text, playerName}}
   * @param {Array}   data.skips             [playerId, …]
   * @param {Object}  data.validations       {playerId: {valid, reason}}
   * @param {Map<string,number>} data.scores
   * @param {boolean} data.isHost
   */
  onRoundResult(data) {
    const {
      question,
      winner,
      winnerName,
      reason,
      answers,
      skips,
      validations,
      scores,
      isHost,
    } = data;

    // -- Build the answers array in the format showRoundResults expects --------
    const answersArray = [];
    if (answers && typeof answers === "object") {
      for (const [pid, ans] of Object.entries(answers)) {
        const val = (validations && validations[pid]) || {};
        answersArray.push({
          playerId: pid,
          playerName: ans.playerName || pid,
          text: ans.text || "",
          valid: val.valid != null ? val.valid : null,
          validReason: val.reason || null,
        });
      }
    }

    // Add skip entries so the results screen shows who skipped
    if (Array.isArray(skips)) {
      for (const pid of skips) {
        // Don't duplicate if the player also somehow has an answer entry
        if (answersArray.some((a) => a.playerId === pid)) continue;
        const name = this._playerName(pid);
        answersArray.push({
          playerId: pid,
          playerName: name,
          text: "(skipped)",
          valid: null,
          validReason: "Player chose to skip.",
        });
      }
    }

    // -- Build the scores object: {playerId: {name, score}} -------------------
    const scoresObj = this._scoresToObject(scores);

    this.showRoundResults({
      question: question || this._gameState.questionText || "",
      winner: winner,
      winnerName: winnerName,
      reason: reason,
      answers: answersArray,
      scores: scoresObj,
    });

    this.showNextRoundButton(isHost);

    console.log("[UI] onRoundResult — winner:", winnerName || "draw");
  }

  /**
   * Called every second while the responder timer is running.
   *
   * @param {number}  seconds    Remaining seconds
   * @param {boolean} isWarning  True when ≤ 10 s remain
   */
  onTimerUpdate(seconds, isWarning) {
    this.updateTimer(seconds);
  }

  /**
   * Called when the questioner asks responders to try again (no valid
   * answers in the previous attempt).
   *
   * @param {string} reason  Explanation shown to the responder
   */
  onRequestNewAnswers(reason) {
    this.showNotification(reason || "Try answering again!", "warning");

    // Re-enable the responder controls and reset the screen
    if (this._gameState.myRole === "responder") {
      this.showResponderScreen(
        this._gameState.roundNum,
        this._gameState.questionText || "",
        this._gameState.wikiUrl,
      );
    }

    console.log("[UI] onRequestNewAnswers");
  }

  // ---------------------------------------------------------------------------
  // Bridge Helpers (private)
  // ---------------------------------------------------------------------------

  /**
   * Look up a player name by id using the stored players list.
   * @param  {string} id
   * @return {string}
   * @private
   */
  _playerName(id) {
    const p = this._gameState.players.find((pl) => pl.id === id);
    return p ? p.name : id;
  }

  /**
   * Convert a scores Map (or plain object of numbers) into the
   * `{playerId: {name, score}}` format that showRoundResults expects.
   *
   * @param  {Map<string,number>|Object} scores
   * @return {Object}
   * @private
   */
  _scoresToObject(scores) {
    const out = {};

    if (scores instanceof Map) {
      for (const [id, score] of scores) {
        out[id] = { name: this._playerName(id), score };
      }
    } else if (scores && typeof scores === "object") {
      for (const [id, score] of Object.entries(scores)) {
        out[id] = {
          name: this._playerName(id),
          score: typeof score === "number" ? score : 0,
        };
      }
    }

    return out;
  }

  /**
   * Update scoreboards from a Map<string, number> (used by onNewRound).
   * @param {Map<string,number>} scores
   * @private
   */
  _updateScoreboardFromMap(scores) {
    const scoresObj = this._scoresToObject(scores);
    this.updateScoreboard(scoresObj);
  }

  // ---------------------------------------------------------------------------
  // AI Settings Modal
  // ---------------------------------------------------------------------------

  /**
   * Open the AI settings modal, optionally pre-filling from existing config.
   * @param {Object} [config]
   * @param {string} [config.provider]
   * @param {string} [config.apiKey]
   * @param {string} [config.baseUrl]
   * @param {string} [config.model]
   */
  showAISettingsModal(config) {
    if (!this.elModal) return;

    this.elModal.classList.remove("hidden");
    this.elModal.classList.add("active");

    // Clear previous status
    this.setModalStatus("", "info");

    if (config) {
      // Select provider
      if (config.provider === "openai-compatible" && this.elProviderCompat) {
        this.elProviderCompat.checked = true;
      } else if (this.elProviderOpenRouter) {
        this.elProviderOpenRouter.checked = true;
      }

      // API key
      if (this.elApiKeyInput && config.apiKey) {
        this.elApiKeyInput.value = config.apiKey;
      }

      // Base URL
      if (this.elBaseUrlInput && config.baseUrl) {
        this.elBaseUrlInput.value = config.baseUrl;
      }

      // Sync base URL visibility
      this._syncBaseUrlVisibility();

      // If we have a model id, store it for later matching
      if (config.model) {
        this.selectedModelId = config.model;
      }
    }

    console.log("[UI] AI Settings modal opened");
  }

  /** Close the AI settings modal. */
  hideAISettingsModal() {
    if (!this.elModal) return;
    this.elModal.classList.add("hidden");
    this.elModal.classList.remove("active");
    console.log("[UI] AI Settings modal closed");
  }

  /**
   * Populate the model list in the modal.
   * @param {Array<{id:string, name:string}>} models
   * @param {string} [selectedModel]  Model id to mark as selected
   */
  updateModelList(models, selectedModel) {
    if (!this.elModelList) return;

    // Remember the selected model
    if (selectedModel) {
      this.selectedModelId = selectedModel;
    }

    this.elModelList.innerHTML = "";

    if (!models || models.length === 0) {
      this.elModelList.innerHTML =
        '<p class="model-list-empty">No models available.</p>';
      return;
    }

    models.forEach((m) => {
      const item = document.createElement("div");
      item.className = "model-item";
      if (m.id === this.selectedModelId) {
        item.classList.add("selected");
      }
      item.setAttribute("data-model-id", m.id);
      item.textContent = m.name || m.id;

      // Click to select
      item.addEventListener("click", () => {
        // Deselect all siblings
        this.elModelList.querySelectorAll(".model-item").forEach((el) => {
          el.classList.remove("selected");
        });
        item.classList.add("selected");
        this.selectedModelId = m.id;
      });

      this.elModelList.appendChild(item);
    });

    console.log(`[UI] Model list updated (${models.length} models)`);
  }

  /**
   * Return the currently selected model id.
   * @returns {string|null}
   */
  getSelectedModel() {
    return this.selectedModelId;
  }

  /**
   * Return which provider radio is currently selected.
   * @returns {'openrouter'|'openai-compatible'}
   */
  getSelectedProvider() {
    if (this.elProviderCompat && this.elProviderCompat.checked) {
      return "openai-compatible";
    }
    return "openrouter";
  }

  /**
   * Filter the model list items by a search string (case-insensitive).
   * @param {string} searchText
   */
  filterModelList(searchText) {
    if (!this.elModelList) return;
    const query = (searchText || "").toLowerCase();

    this.elModelList.querySelectorAll(".model-item").forEach((item) => {
      const name = (item.textContent || "").toLowerCase();
      if (name.includes(query)) {
        item.style.display = "";
      } else {
        item.style.display = "none";
      }
    });
  }

  /**
   * Set the status message inside the AI settings modal.
   * @param {string} text
   * @param {'info'|'success'|'error'} type
   */
  setModalStatus(text, type = "info") {
    if (!this.elModalStatus) return;

    this.elModalStatus.textContent = text;

    // Reset classes
    this.elModalStatus.className = "settings-status";
    if (text) {
      this.elModalStatus.classList.add(`status-${type}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Toast Notifications
  // ---------------------------------------------------------------------------

  /** Icon map for toast types */
  static TOAST_ICONS = {
    info: "ℹ️",
    success: "✅",
    error: "❌",
    warning: "⚠️",
  };

  /**
   * Show a toast notification that auto-dismisses.
   * @param {string}  text
   * @param {'info'|'success'|'error'|'warning'} [type='info']
   * @param {number}  [duration=4000]  Auto-dismiss time in ms
   */
  showNotification(text, type = "info", duration = 4000) {
    if (!this.elToastContainer) return;

    const icon = UIManager.TOAST_ICONS[type] || UIManager.TOAST_ICONS.info;

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.setAttribute("role", "alert");
    toast.innerHTML = `
      <span class="toast-icon">${icon}</span>
      <span class="toast-text">${escapeHtml(text)}</span>
    `;

    this.elToastContainer.appendChild(toast);

    // Auto-remove after duration
    const removeTimer = setTimeout(() => {
      this._removeToast(toast);
    }, duration);

    // Allow clicking to dismiss early
    toast.addEventListener("click", () => {
      clearTimeout(removeTimer);
      this._removeToast(toast);
    });

    console.log(`[UI] Toast (${type}): ${text}`);
  }

  /**
   * Animate out and remove a toast element.
   * @param {HTMLElement} toast
   */
  _removeToast(toast) {
    if (!toast || !toast.parentNode) return;

    toast.classList.add("removing");

    // Wait for the CSS slide-out animation to finish, then remove from DOM
    const onEnd = () => {
      toast.removeEventListener("animationend", onEnd);
      toast.removeEventListener("transitionend", onEnd);
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    };

    toast.addEventListener("animationend", onEnd);
    toast.addEventListener("transitionend", onEnd);

    // Safety fallback: remove after 500ms regardless
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 500);
  }

  // ---------------------------------------------------------------------------
  // Connection Status
  // ---------------------------------------------------------------------------

  /**
   * Update the global connection status indicator.
   * @param {'connected'|'connecting'|'disconnected'|'error'} status
   */
  updateConnectionStatus(status) {
    if (!this.elConnectionStatus) return;

    this.elConnectionStatus.setAttribute("data-state", status);

    const dot = this.elConnectionStatus.querySelector(".connection-dot");
    const text = this.elConnectionStatus.querySelector(".connection-text");

    // Remove all status classes from the dot
    if (dot) {
      dot.className = "connection-dot";

      switch (status) {
        case "connected":
          dot.classList.add("status-connected");
          break;
        case "connecting":
          dot.classList.add("status-connecting");
          break;
        case "disconnected":
          dot.classList.add("status-disconnected");
          break;
        case "error":
          dot.classList.add("status-disconnected");
          break;
        default:
          dot.classList.add("status-disconnected");
      }
    }

    // Friendly text
    const labels = {
      connected: "Connected",
      connecting: "Connecting…",
      disconnected: "Disconnected",
      error: "Connection Error",
    };

    if (text) {
      text.textContent = labels[status] || "Unknown";
    }
  }

  // ---------------------------------------------------------------------------
  // Responder Helpers
  // ---------------------------------------------------------------------------

  /**
   * Set the status text shown below the responder answer area.
   * @param {string} text
   */
  setResponderStatus(text) {
    if (this.elResponderStatus) {
      this.elResponderStatus.textContent = text;
    }
  }

  /**
   * Disable all answer-related controls on the responder screen.
   */
  disableAnswerControls() {
    if (this.elAnswerInput) this.elAnswerInput.disabled = true;
    if (this.elBtnSubmitAnswer) this.elBtnSubmitAnswer.disabled = true;
    if (this.elBtnSkipAnswer) this.elBtnSkipAnswer.disabled = true;
  }

  // ---------------------------------------------------------------------------
  // Utility: Color from Name
  // ---------------------------------------------------------------------------

  /**
   * Generate a consistent HSL colour string from a player name.
   * Uses a simple hash to derive a hue so the same name always gets the same colour.
   * @param  {string} name
   * @return {string} HSL colour string, e.g. "hsl(217, 70%, 55%)"
   */
  colorFromName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
      hash = hash & hash; // Convert to 32-bit int
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 55%)`;
  }
}

// =============================================================================
// Utility: HTML Escaping
// =============================================================================

/**
 * Escape user-generated text to prevent XSS when inserted via innerHTML.
 * @param  {string} str  Raw text
 * @return {string}      Escaped text safe for HTML insertion
 */
function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// =============================================================================
// Export
// =============================================================================

window.UIManager = UIManager;
