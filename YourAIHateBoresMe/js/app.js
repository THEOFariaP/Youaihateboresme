/**
 * app.js — Main entry point for YourAIHateBores.me
 *
 * Wires together the four core modules (NetworkManager, AIProvider,
 * GameManager, UIManager) and connects UI events to game/network/AI
 * actions.  This file is purely procedural — no classes are exported.
 *
 * Load order (all deferred):
 *   network.js  →  ai.js  →  game.js  →  ui.js  →  app.js
 */

document.addEventListener("DOMContentLoaded", () => {
  // ------------------------------------------------------------------
  // 1. Create module instances
  // ------------------------------------------------------------------
  const network = new NetworkManager();
  const ai = new AIProvider();
  const ui = new UIManager();
  const game = new GameManager();

  // ------------------------------------------------------------------
  // 2. Initialise the game with its dependencies
  // ------------------------------------------------------------------
  game.init(network, ai, ui);

  // ------------------------------------------------------------------
  // 3. Initialise UI event listeners (DOM bindings inside UIManager)
  // ------------------------------------------------------------------
  ui.initEventListeners();

  // ------------------------------------------------------------------
  // 4. Reflect saved AI configuration in the UI
  // ------------------------------------------------------------------
  ui.updateAIStatus(ai.isConfigured());

  // ------------------------------------------------------------------
  // 5. Wire cross-module events
  // ------------------------------------------------------------------
  wireEvents(network, ai, game, ui);

  console.log("[App] YourAIHateBores.me initialised ✓");
});

// ====================================================================
// wireEvents — connects every UI / network / game event to the
// appropriate handler across modules.
// ====================================================================

function wireEvents(network, ai, game, ui) {
  // ----------------------------------------------------------------
  // Helper: decide whether the "Start Game" button should be enabled
  // ----------------------------------------------------------------
  function updateStartButton() {
    const isHost = network.isHost();
    const canStart =
      isHost && network.getPlayers().length >= 3 && ai.isConfigured();
    ui.enableStartButton(canStart, isHost);
  }

  // ================================================================
  //  Room Management
  // ================================================================

  /**
   * Create a new room.
   * The host's PeerJS id becomes the room code that others use to join.
   */
  ui.on("create-room", async (username) => {
    try {
      ui.updateConnectionStatus("connecting");

      const roomCode = await network.createRoom(username);

      ui.showLobby(roomCode);
      ui.updatePlayerList(network.getPlayers(), network.getMyId());
      ui.showNotification("Room created!", "success");
      updateStartButton();
    } catch (err) {
      console.error("[App] Failed to create room:", err);
      ui.showNotification(
        err.message || "Could not create room. Please try again.",
        "error",
      );
      ui.updateConnectionStatus("disconnected");
    }
  });

  /**
   * Join an existing room using a room code another player shared.
   */
  ui.on("join-room", async (roomCode, username) => {
    try {
      ui.updateConnectionStatus("connecting");

      await network.joinRoom(roomCode.toUpperCase(), username);

      ui.showLobby(roomCode.toUpperCase());
      ui.updatePlayerList(network.getPlayers(), network.getMyId());
      ui.showNotification("Joined room!", "success");
      updateStartButton();
    } catch (err) {
      console.error("[App] Failed to join room:", err);
      ui.showNotification(
        err.message || "Could not connect. Check the room code and try again.",
        "error",
      );
      ui.updateConnectionStatus("disconnected");
    }
  });

  // ================================================================
  //  Network Events
  // ================================================================

  /**
   * A new player connected to the room.
   */
  network.on("player-joined", (player) => {
    ui.updatePlayerList(network.getPlayers(), network.getMyId());
    ui.showNotification(`${player.name} joined!`, "info");
    updateStartButton();
  });

  /**
   * A player disconnected / left the room.
   */
  network.on("player-left", (player) => {
    ui.updatePlayerList(network.getPlayers(), network.getMyId());
    ui.showNotification(`${player.name} left`, "warning");
    updateStartButton();
  });

  /**
   * Connection status changed (connecting / connected / disconnected).
   */
  network.on("connection-status", (status) => {
    ui.updateConnectionStatus(status);
  });

  /**
   * A network error occurred.  Fatal errors send the user back to the
   * welcome screen so they can reconnect.
   */
  network.on("error", (error) => {
    console.error("[App] Network error:", error);
    ui.showNotification(error.message || "A network error occurred.", "error");

    if (error.fatal) {
      ui.showWelcome();
    }
  });

  /**
   * The room is in the middle of host migration.
   */
  network.on("host-migration-started", (info) => {
    console.warn("[App] Host migration started:", info);
    ui.showNotification("Host migrated. Reconnecting room…", "warning", 2500);
    ui.updateConnectionStatus("connecting");
  });

  /**
   * A new host was elected and the room recovered.
   */
  network.on("host-changed", (info) => {
    console.info("[App] Host changed:", info);

    ui.updatePlayerList(network.getPlayers(), network.getMyId());
    updateStartButton();

    if (info && info.isMe) {
      ui.showNotification("You are now the room host.", "success", 3000);
    } else {
      ui.showNotification(
        "Room recovered after host migration.",
        "success",
        2500,
      );
    }

    ui.updateConnectionStatus("connected");
  });

  /**
   * Disconnected from the room unexpectedly.  Give the user a moment
   * to read the notification before resetting the UI.
   */
  network.on("disconnected", () => {
    ui.showNotification("Disconnected from room", "error");
    setTimeout(() => {
      ui.showWelcome();
    }, 1500);
  });

  // ================================================================
  //  Game Events (UI → GameManager)
  // ================================================================

  /**
   * Host presses "Start Game".
   * Validates preconditions before kicking things off.
   */
  ui.on("start-game", () => {
    if (!network.isHost()) return;

    if (network.getPlayers().length < 3) {
      ui.showNotification(
        "You need at least 3 players to start the game.",
        "warning",
      );
      return;
    }

    if (!ai.isConfigured()) {
      ui.showNotification(
        "Please configure AI settings before starting.",
        "warning",
      );
      ui.showAISettingsModal(ai.getConfig());
      return;
    }

    game.startGame();
  });

  /**
   * Player submits a trivia question for the current round.
   */
  ui.on("submit-question", async (text) => {
    try {
      await game.submitQuestion(text);
    } catch (err) {
      console.error("[App] Error submitting question:", err);
      ui.showNotification(err.message || "Failed to submit question.", "error");
    }
  });

  /**
   * Player submits their answer to the current question.
   */
  ui.on("submit-answer", (text) => {
    game.submitAnswer(text);
  });

  /**
   * Player chooses to skip answering.
   */
  ui.on("skip-answer", () => {
    game.skipAnswer();
  });

  /**
   * Host advances to the next round.
   */
  ui.on("next-round", () => {
    game.nextRound();
  });

  // ================================================================
  //  AI Settings Events
  // ================================================================

  /**
   * Open the AI settings modal, pre-filled with current configuration.
   */
  ui.on("open-ai-settings", () => {
    ui.showAISettingsModal(ai.getConfig());
  });

  /**
   * Fetch available models from the selected provider so the user can
   * pick one from a dropdown.
   */
  ui.on("fetch-models", async () => {
    try {
      const provider = ui.getSelectedProvider();
      const apiKey = document.getElementById("ai-api-key").value.trim();
      const baseUrl = document.getElementById("ai-base-url").value.trim();

      // Temporarily configure the provider so fetchModels() uses the
      // correct endpoint and credentials.
      ai.configure({
        provider,
        apiKey,
        baseUrl,
        model: ai.model, // keep current model selection while fetching
      });

      ui.setModalStatus("Fetching models...", "info");

      const models = await ai.fetchModels();
      ui.updateModelList(models, ai.model);
      ui.setModalStatus("Models loaded successfully!", "success");
    } catch (err) {
      console.error("[App] Error fetching models:", err);
      ui.setModalStatus(
        err.message ||
          "Failed to fetch models. Check your API key and try again.",
        "error",
      );
    }
  });

  /**
   * Save the AI settings entered in the modal.
   */
  ui.on("save-ai-settings", ({ provider, apiKey, baseUrl, model }) => {
    const selectedModel = ui.getSelectedModel();

    if (!selectedModel) {
      ui.setModalStatus("Please select a model before saving.", "error");
      return;
    }

    ai.configure({
      provider,
      apiKey,
      baseUrl,
      model: selectedModel,
    });

    ui.updateAIStatus(ai.isConfigured());
    ui.hideAISettingsModal();
    ui.showNotification("AI settings saved!", "success");
    updateStartButton();
  });
}

// ====================================================================
// Global error handlers — safety net for uncaught exceptions /
// unhandled promise rejections so the player always sees *something*
// instead of a silent failure.
// ====================================================================

window.onerror = function (message, source, lineno, colno, error) {
  console.error("[App] Uncaught error:", {
    message,
    source,
    lineno,
    colno,
    error,
  });

  try {
    // UIManager may not be available yet if the error fires very early.
    if (typeof UIManager !== "undefined") {
      // We don't have a direct reference to the ui instance here, so
      // fall back to a plain DOM notification if possible.
      const container =
        document.getElementById("notification-container") || document.body;
      const note = document.createElement("div");
      note.className = "notification error";
      note.textContent =
        "An unexpected error occurred. Please refresh the page.";
      container.appendChild(note);
      setTimeout(() => note.remove(), 6000);
    }
  } catch (_) {
    /* best-effort — don't throw inside the error handler */
  }
};

window.onunhandledrejection = function (event) {
  console.error("[App] Unhandled promise rejection:", event.reason);

  try {
    const container =
      document.getElementById("notification-container") || document.body;
    const note = document.createElement("div");
    note.className = "notification error";
    note.textContent = "Something went wrong. Please try again or refresh.";
    container.appendChild(note);
    setTimeout(() => note.remove(), 6000);
  } catch (_) {
    /* best-effort */
  }
};
