/**
 * NetworkManager v2 — serverless P2P via Trystero (BitTorrent WebSocket trackers).
 *
 * Why Trystero instead of PeerJS?
 * --------------------------------
 * PeerJS requires a dedicated signaling server (0.peerjs.com) which is a shared
 * public resource prone to outages. Trystero uses public BitTorrent WebSocket
 * trackers (openwebtorrent.com, btorrent.xyz) as the signaling layer — these are
 * maintained by the BitTorrent community, handle millions of clients, and require
 * zero server-side configuration.
 *
 * Architecture
 * ------------
 * All peers join the same Trystero room using a shared appId + roomId. Trystero
 * handles WebRTC discovery and data channels automatically. On top of that we run
 * a logical "host" layer for game coordination:
 *
 *   - Every peer generates a stable logical ID: "yhb-<16 hex chars>"
 *   - On join, peers exchange "hello" messages to announce themselves
 *   - After HANDSHAKE_WAIT_MS, the peer with the earliest joinedAt becomes host
 *   - Host distributes authoritative room snapshots on a heartbeat timer
 *   - When host leaves, remaining peers re-elect deterministically (no reconnect needed)
 *
 * Security
 * --------
 * - All strings are sanitised and length-limited before sending or applying
 * - Incoming payloads are validated (type, depth, key count)
 * - Duplicate messages are deduplicated via _msgId
 * - The host role controls only transport/relay; AI moderation stays client-side
 */

class NetworkManager {
  constructor() {
    /** Trystero joinRoom function — loaded dynamically via ESM import */
    this._joinRoomFn = null;

    /** Active Trystero room object */
    this.trysteroRoom = null;

    /** Trystero sendData action (broadcasts or sends to specific peers) */
    this._sendData = null;

    /** trystero peer id → logical peer id */
    this._trysteroToLogical = new Map();

    /** logical peer id → trystero peer id */
    this._logicalToTrystero = new Map();

    /** @type {Map<string, {id:string, name:string, isHost:boolean, joinedAt:number}>} */
    this.players = new Map();

    /** @type {Object<string, Function[]>} */
    this.listeners = {};

    this.roomVersion = 0;
    this.myId = null;
    this.myName = null;
    this.roomCode = null;
    this.isHostPlayer = false;
    this.currentHostId = null;
    this.previousHostId = null;
    this.createdAt = null;
    this.playerOrder = [];
    this.roomSnapshot = null;
    this.gameState = null;
    this.backupHostIds = [];
    this.manualDisconnect = false;
    this.hostMigrationInProgress = false;
    this.reconnectTimer = null;
    this.snapshotHeartbeatTimer = null;
    this.lastSnapshotAt = null;
    this.knownPeerIds = new Set();
    this.processedMessageIds = new Set();

    this.MAX_NAME_LENGTH = 20;
    this.MAX_TEXT_LENGTH = 2000;
    this.GLOBAL_ROOM_CODE = "GLOBAL";

    // Trystero config — must be unique to this app so no cross-app conflicts
    this.TRYSTERO_APP_ID = "youraihateboresme-v1";
    this.TRYSTERO_ROOM_ID = "global";

    // How long to wait for peer hellos before electing host on first join
    this.HANDSHAKE_WAIT_MS = 2000;
    this.SNAPSHOT_HEARTBEAT_MS = 4000;
  }

  // ---------------------------------------------------------------------------
  // Event emitter
  // ---------------------------------------------------------------------------

  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  off(event, callback) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
  }

  emit(event, ...args) {
    const callbacks = this.listeners[event];
    if (!callbacks || callbacks.length === 0) return;
    for (const cb of [...callbacks]) {
      try {
        cb(...args);
      } catch (err) {
        console.error(`[Network] Error in "${event}" listener:`, err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Connect to the global room automatically.
   * Uses Trystero with BitTorrent tracker signaling — no dedicated server needed.
   */
  async connectAutoGlobal() {
    this.manualDisconnect = false;
    this._clearReconnectTimer();
    this._resetRuntimeState();

    this.roomCode = this.GLOBAL_ROOM_CODE;
    this.myId = this._generatePeerId();
    this.myName = this._generateAutoName();
    this.createdAt = Date.now();

    this.emit("connection-status", "connecting");
    console.log(`[Network] connectAutoGlobal — myId=${this.myId}`);

    await this._loadTrystero();
    await this._joinTrysteroRoom();

    return {
      roomCode: this.roomCode,
      role: this.isHostPlayer ? "host" : "client",
      playerId: this.myId,
    };
  }

  broadcast(message) {
    const safe = this._sanitizeOutboundMessage(message);
    if (!safe) return;

    if (this.isHostPlayer) {
      // Host sends directly to all connected peers
      this._trysteroSend(safe);
      return;
    }

    // Clients send to host for relay
    const hostTid = this._logicalToTrystero.get(this.currentHostId);
    if (hostTid) {
      this._trysteroSend(
        { type: "relay", payload: safe, _relayId: this._makeMessageId() },
        [hostTid],
      );
    } else {
      console.warn("[Network] Cannot broadcast — host not connected.");
    }
  }

  send(peerId, message) {
    const targetId = this._sanitizePeerId(peerId);
    const safe = this._sanitizeOutboundMessage(message);
    if (!targetId || !safe) return;

    if (targetId === this.myId) {
      this.emit("message", safe);
      return;
    }

    if (this.isHostPlayer) {
      const targetTid = this._logicalToTrystero.get(targetId);
      if (targetTid) {
        this._trysteroSend(safe, [targetTid]);
      }
      return;
    }

    const hostTid = this._logicalToTrystero.get(this.currentHostId);
    if (hostTid) {
      this._trysteroSend(
        { type: "relay-to", target: targetId, payload: safe, _relayId: this._makeMessageId() },
        [hostTid],
      );
    }
  }

  getPlayers() {
    return Array.from(this.players.values()).sort((a, b) => {
      const ai = this.playerOrder.indexOf(a.id);
      const bi = this.playerOrder.indexOf(b.id);
      return ai - bi;
    });
  }

  isHost() { return this.isHostPlayer; }
  getMyId() { return this.myId; }
  getMyName() { return this.myName; }
  getCurrentHostId() { return this.currentHostId; }

  getRoomSnapshot() {
    return this.roomSnapshot ? this._deepClone(this.roomSnapshot) : null;
  }

  updateGameState(partialState = {}) {
    if (!partialState || typeof partialState !== "object") return;
    this.gameState = {
      ...(this.gameState || {}),
      ...this._sanitizeGameState(partialState),
      updatedAt: Date.now(),
      updatedBy: this.myId,
    };

    if (this.isHostPlayer) {
      this._publishSnapshot();
    } else {
      const hostTid = this._logicalToTrystero.get(this.currentHostId);
      if (hostTid) {
        this._trysteroSend(
          { type: "room-state-update", state: this.gameState },
          [hostTid],
        );
      }
    }
  }

  disconnect() {
    this.manualDisconnect = true;
    this._clearReconnectTimer();
    this._stopSnapshotHeartbeat();

    if (this.trysteroRoom) {
      try { this.trysteroRoom.leave(); } catch (_) {}
      this.trysteroRoom = null;
    }

    this._sendData = null;
    this._trysteroToLogical.clear();
    this._logicalToTrystero.clear();
    this.players.clear();
    this.playerOrder = [];
    this.currentHostId = null;
    this.previousHostId = null;
    this.roomSnapshot = null;
    this.gameState = null;
    this.roomVersion = 0;
    this.lastSnapshotAt = null;
    this.isHostPlayer = false;
    this.hostMigrationInProgress = false;

    this.emit("connection-status", "disconnected");
    this.emit("disconnected", { reason: "Local disconnect" });
  }

  // ---------------------------------------------------------------------------
  // Trystero internals
  // ---------------------------------------------------------------------------

  async _loadTrystero() {
    if (this._joinRoomFn) return;
    console.log("[Network] Loading Trystero via dynamic ESM import...");
    try {
      // Dynamic import works inside classic <script defer> tags in all modern browsers.
      // Use the official torrent strategy package with CDN fallbacks.
      const importUrls = [
        "https://esm.run/@trystero-p2p/torrent",
        "https://esm.sh/@trystero-p2p/torrent?bundle",
        "https://cdn.jsdelivr.net/npm/@trystero-p2p/torrent/+esm",
      ];

      let lastError = null;
      let mod = null;

      for (const url of importUrls) {
        try {
          mod = await import(url);
          console.log(`[Network] Trystero loaded from ${url} ✓`);
          break;
        } catch (err) {
          lastError = err;
          console.warn(`[Network] Trystero import failed from ${url}:`, err);
        }
      }

      if (!mod) {
        throw lastError || new Error("Unable to load Trystero");
      }

      this._joinRoomFn = mod.joinRoom || (mod.default && mod.default.joinRoom) || mod.default;
      if (typeof this._joinRoomFn !== "function") {
        throw new Error("Trystero module loaded, but joinRoom was not found.");
      }
      console.log("[Network] Trystero loaded ✓");
    } catch (err) {
      console.error("[Network] Failed to load Trystero:", err);
      throw new Error(
        "Could not load the P2P library. Check your internet connection and try again.",
      );
    }
  }

  async _joinTrysteroRoom() {
    const room = this._joinRoomFn(
      { appId: this.TRYSTERO_APP_ID },
      this.TRYSTERO_ROOM_ID,
    );

    this.trysteroRoom = room;

    // Single shared data channel for all messages
    const [sendData, getData] = room.makeAction("data");
    this._sendData = sendData;

    // Register myself immediately
    this.players.set(this.myId, {
      id: this.myId,
      name: this.myName,
      isHost: false,
      joinedAt: this.createdAt,
    });
    this.playerOrder = [this.myId];

    room.onPeerJoin((trysteroId) => this._onPeerJoin(trysteroId));
    room.onPeerLeave((trysteroId) => this._onPeerLeave(trysteroId));
    getData((data, trysteroId) => this._onData(data, trysteroId));

    // Wait for existing peers to send their hellos back to us
    await new Promise((resolve) => setTimeout(resolve, this.HANDSHAKE_WAIT_MS));

    // Elect host deterministically from all known players
    this._electHost();

    this.emit("connection-status", "connected");
    this.emit("connected", {
      id: this.myId,
      roomCode: this.roomCode,
      isHost: this.isHostPlayer,
    });

    if (this.isHostPlayer) {
      this._startSnapshotHeartbeat();
      this._publishSnapshot();
    }
  }

  _onPeerJoin(trysteroId) {
    console.log(`[Network] Trystero peer joined: ${trysteroId}`);

    // Announce ourselves to the new peer
    this._trysteroSend(
      {
        type: "hello",
        peerId: this.myId,
        name: this.myName,
        joinedAt: this.createdAt,
        currentHostId: this.currentHostId,
      },
      [trysteroId],
    );

    // If we are already host, immediately send them the current snapshot
    if (this.isHostPlayer) {
      this._trysteroSend(
        { type: "room-snapshot", snapshot: this._makeSnapshot() },
        [trysteroId],
      );
    }
  }

  _onPeerLeave(trysteroId) {
    const logicalId = this._trysteroToLogical.get(trysteroId);
    this._trysteroToLogical.delete(trysteroId);
    if (logicalId) this._logicalToTrystero.delete(logicalId);
    if (logicalId) this._removePlayer(logicalId);
  }

  _onData(raw, trysteroId) {
    const data = this._sanitizeIncomingMessage(raw);
    if (!data) return;

    switch (data.type) {
      case "hello":
        this._handleHello(data, trysteroId);
        break;

      case "room-snapshot":
        if (data.snapshot) this._applySnapshot(data.snapshot);
        break;

      case "room-state-update":
        if (this.isHostPlayer) {
          this.gameState = this._sanitizeGameState(data.state || {});
          this._bumpRoomVersion();
          this._publishSnapshot();
        }
        break;

      case "relay": {
        if (!this.isHostPlayer) return;
        const payload = this._sanitizeIncomingMessage(data.payload);
        if (!payload) return;
        const senderLogical = this._trysteroToLogical.get(trysteroId);
        for (const [lid, tid] of this._logicalToTrystero) {
          if (lid !== senderLogical) this._trysteroSend(payload, [tid]);
        }
        this.emit("message", payload);
        break;
      }

      case "relay-to": {
        if (!this.isHostPlayer) return;
        const target = this._sanitizePeerId(data.target);
        const payload = this._sanitizeIncomingMessage(data.payload);
        if (!target || !payload) return;
        if (target === this.myId) {
          this.emit("message", payload);
        } else {
          const targetTid = this._logicalToTrystero.get(target);
          if (targetTid) this._trysteroSend(payload, [targetTid]);
        }
        break;
      }

      default:
        this.emit("message", data);
        break;
    }
  }

  _handleHello(data, trysteroId) {
    const logicalId = this._sanitizePeerId(data.peerId);
    if (!logicalId || logicalId === this.myId) return;

    // Register ID mapping
    this._trysteroToLogical.set(trysteroId, logicalId);
    this._logicalToTrystero.set(logicalId, trysteroId);

    const name = this._sanitizeName(data.name) || "Player";
    const joinedAt = typeof data.joinedAt === "number" ? data.joinedAt : Date.now();

    if (!this.players.has(logicalId)) {
      const playerInfo = { id: logicalId, name, isHost: false, joinedAt };
      this.players.set(logicalId, playerInfo);
      if (!this.playerOrder.includes(logicalId)) {
        this.playerOrder.push(logicalId);
      }
      this._rememberPeerId(logicalId);
      this._bumpRoomVersion();
      this.emit("player-joined", playerInfo);

      if (this.isHostPlayer) {
        this._reflagHostInPlayers();
        this._publishSnapshot();
      }
    }

    // If no host yet, or if this peer was there before us, re-elect
    if (!this.currentHostId || (this.isHostPlayer && joinedAt < this.createdAt)) {
      this._electHost();
    }
  }

  // ---------------------------------------------------------------------------
  // Host election
  // ---------------------------------------------------------------------------

  /**
   * Deterministically elect host from current players.
   * Host = earliest joinedAt; peerId is the tiebreaker.
   * Safe to call multiple times — idempotent if result doesn't change.
   */
  _electHost() {
    const all = Array.from(this.players.values()).sort((a, b) => {
      if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
      return a.id.localeCompare(b.id);
    });

    if (all.length === 0) return;

    const elected = all[0];
    const wasHost = this.isHostPlayer;

    this.currentHostId = elected.id;
    this.isHostPlayer = elected.id === this.myId;
    this.hostMigrationInProgress = false;
    this._reflagHostInPlayers();
    this.backupHostIds = all.slice(1, 4).map((p) => p.id);

    if (this.isHostPlayer && !wasHost) {
      this.roomVersion = Math.max(this.roomVersion, 1);
      this._startSnapshotHeartbeat();
      this._publishSnapshot();
      this.emit("host-changed", { currentHostId: this.myId, isMe: true });
      this.emit("connection-status", "connected");
    } else if (!this.isHostPlayer && wasHost) {
      this._stopSnapshotHeartbeat();
    }
  }

  // ---------------------------------------------------------------------------
  // Player management
  // ---------------------------------------------------------------------------

  _removePlayer(logicalId) {
    const clean = this._sanitizePeerId(logicalId);
    if (!clean || !this.players.has(clean)) return;

    const info = this.players.get(clean);
    const wasHost = clean === this.currentHostId;

    this.players.delete(clean);
    this.playerOrder = this.playerOrder.filter((id) => id !== clean);

    console.log(`[Network] Player "${info.name}" left (${clean})`);
    this.emit("player-left", { id: clean, name: info.name, isHost: !!info.isHost });

    if (wasHost) {
      this.previousHostId = clean;
      this.currentHostId = null;
      this.isHostPlayer = false;
      this._stopSnapshotHeartbeat();
      this.emit("host-migration-started", {
        previousHostId: this.previousHostId,
        nextHostId: null,
      });
      // Re-elect immediately — no reconnect steps needed with Trystero mesh
      this._electHost();
    } else if (this.isHostPlayer) {
      this._bumpRoomVersion();
      this._publishSnapshot();
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot handling
  // ---------------------------------------------------------------------------

  _makeSnapshot() {
    return {
      roomCode: this.roomCode,
      version: this.roomVersion,
      currentHostId: this.currentHostId,
      backupHostIds: this.backupHostIds,
      createdAt: this.createdAt,
      playerOrder: [...this.playerOrder],
      players: this.getPlayers(),
      gameState: this._deepClone(this.gameState || {}),
      updatedAt: Date.now(),
    };
  }

  _publishSnapshot() {
    if (!this.isHostPlayer || !this._sendData) return;
    const snapshot = this._makeSnapshot();
    this.roomSnapshot = snapshot;
    this.lastSnapshotAt = Date.now();
    this._trysteroSend({ type: "room-snapshot", snapshot });
  }

  _applySnapshot(snapshot) {
    const safe = this._sanitizeSnapshot(snapshot);
    if (!safe) return;
    if (safe.version < this.roomVersion) return;

    const previousPlayers = new Map(this.players);
    this.roomSnapshot = safe;
    this.roomVersion = safe.version;
    this.roomCode = safe.roomCode;
    this.currentHostId = safe.currentHostId;
    this.backupHostIds = safe.backupHostIds || [];
    this.createdAt = safe.createdAt;
    this.playerOrder = [...safe.playerOrder];
    this.gameState = this._sanitizeGameState(safe.gameState || {});
    this.lastSnapshotAt = Date.now();

    this.players.clear();
    for (const p of safe.players) {
      this.players.set(p.id, {
        id: p.id,
        name: p.name,
        isHost: !!p.isHost,
        joinedAt: typeof p.joinedAt === "number" ? p.joinedAt : Date.now(),
      });
      this._rememberPeerId(p.id);
    }

    // Ensure we are in the player list even if the snapshot omitted us briefly
    if (!this.players.has(this.myId)) {
      this.players.set(this.myId, {
        id: this.myId,
        name: this.myName,
        isHost: this.currentHostId === this.myId,
        joinedAt: this.createdAt,
      });
      if (!this.playerOrder.includes(this.myId)) this.playerOrder.push(this.myId);
    }

    const wasHost = this.isHostPlayer;
    this.isHostPlayer = this.currentHostId === this.myId;
    if (!this.isHostPlayer && wasHost) this._stopSnapshotHeartbeat();

    for (const [id, info] of this.players) {
      if (!previousPlayers.has(id)) this.emit("player-joined", info);
    }
    for (const [id, info] of previousPlayers) {
      if (!this.players.has(id)) this.emit("player-left", info);
    }
  }

  _startSnapshotHeartbeat() {
    this._stopSnapshotHeartbeat();
    this.snapshotHeartbeatTimer = setInterval(() => {
      if (this.isHostPlayer) this._publishSnapshot();
    }, this.SNAPSHOT_HEARTBEAT_MS);
  }

  _stopSnapshotHeartbeat() {
    if (this.snapshotHeartbeatTimer !== null) {
      clearInterval(this.snapshotHeartbeatTimer);
      this.snapshotHeartbeatTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Trystero send helper
  // ---------------------------------------------------------------------------

  /**
   * Send data via Trystero.
   * @param {Object} data      Sanitized message object
   * @param {string[]} [peerIds]  Trystero peer IDs to send to. Omit to broadcast.
   */
  _trysteroSend(data, peerIds) {
    if (!this._sendData) return;
    try {
      if (peerIds && peerIds.length) {
        this._sendData(data, peerIds);
      } else {
        this._sendData(data);
      }
    } catch (err) {
      console.error("[Network] Trystero send failed:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // ID generation and sanitization
  // ---------------------------------------------------------------------------

  /** Generate a cryptographically random logical peer ID */
  _generatePeerId() {
    try {
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
      return `yhb-${hex}`;
    } catch (_) {
      const rand = Math.random().toString(16).slice(2, 18).padEnd(16, "0");
      return `yhb-${rand}`;
    }
  }

  _generateAutoName() {
    const n = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
    return `Player-${n}`;
  }

  /**
   * Validate and normalise a logical peer ID.
   * Format: yhb-<16 lowercase hex chars>
   */
  _sanitizePeerId(id) {
    if (typeof id !== "string") return null;
    const clean = id.trim().toLowerCase();
    if (!/^yhb-[0-9a-f]{16}$/.test(clean)) return null;
    return clean;
  }

  _sanitizeName(name) {
    if (typeof name !== "string") return "";
    let v = name.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
    if (v.length > this.MAX_NAME_LENGTH) v = v.slice(0, this.MAX_NAME_LENGTH).trim();
    return v;
  }

  _sanitizeText(text, maxLength = this.MAX_TEXT_LENGTH) {
    if (typeof text !== "string") return "";
    let v = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
    if (v.length > maxLength) v = v.slice(0, maxLength);
    return v;
  }

  _sanitizeOutgoingMessageValue(value, depth = 0) {
    if (depth > 8) return null;
    if (value == null) return value;
    if (typeof value === "string") return this._sanitizeText(value);
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value;
    if (Array.isArray(value)) {
      return value.slice(0, 100).map((item) => this._sanitizeOutgoingMessageValue(item, depth + 1));
    }
    if (typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value).slice(0, 100)) {
        if (typeof k === "string") out[k] = this._sanitizeOutgoingMessageValue(v, depth + 1);
      }
      return out;
    }
    return null;
  }

  _sanitizeOutboundMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return null;
    if (typeof message.type !== "string" || !message.type.trim()) return null;
    const safe = this._sanitizeOutgoingMessageValue(message);
    safe.type = this._sanitizeText(message.type, 64);
    if (!safe._msgId) safe._msgId = this._makeMessageId();
    return safe;
  }

  _sanitizeIncomingMessage(message) {
    const safe = this._sanitizeOutboundMessage(message);
    if (!safe) return null;
    if (safe._msgId && this.processedMessageIds.has(safe._msgId)) return safe;
    if (safe._msgId) {
      this.processedMessageIds.add(safe._msgId);
      if (this.processedMessageIds.size > 500) {
        const first = this.processedMessageIds.values().next().value;
        this.processedMessageIds.delete(first);
      }
    }
    return safe;
  }

  _sanitizeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    const currentHostId = this._sanitizePeerId(snapshot.currentHostId);
    const roomCode =
      typeof snapshot.roomCode === "string" ? snapshot.roomCode.slice(0, 10) : "GLOBAL";
    const createdAt = typeof snapshot.createdAt === "number" ? snapshot.createdAt : Date.now();
    const version = typeof snapshot.version === "number" ? snapshot.version : 0;
    if (!currentHostId) return null;

    const playerOrder = Array.isArray(snapshot.playerOrder)
      ? snapshot.playerOrder.map((id) => this._sanitizePeerId(id)).filter(Boolean)
      : [];

    const players = Array.isArray(snapshot.players)
      ? snapshot.players
          .map((p) => {
            const id = this._sanitizePeerId(p && p.id);
            if (!id) return null;
            return {
              id,
              name: this._sanitizeName(p.name) || "Player",
              isHost: !!p.isHost,
              joinedAt: typeof p.joinedAt === "number" ? p.joinedAt : Date.now(),
            };
          })
          .filter(Boolean)
      : [];

    const backupHostIds = Array.isArray(snapshot.backupHostIds)
      ? snapshot.backupHostIds.map((id) => this._sanitizePeerId(id)).filter(Boolean)
      : [];

    return {
      roomCode,
      version,
      currentHostId,
      backupHostIds,
      createdAt,
      playerOrder,
      players,
      gameState: this._sanitizeGameState(snapshot.gameState || {}),
      updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : Date.now(),
    };
  }

  _sanitizeGameState(state) {
    return this._sanitizeOutgoingMessageValue(state || {}, 0) || {};
  }

  _makeMessageId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  _bumpRoomVersion() { this.roomVersion += 1; }

  _reflagHostInPlayers() {
    for (const [id, player] of this.players) {
      this.players.set(id, { ...player, isHost: id === this.currentHostId });
    }
  }

  _rememberPeerId(peerId) {
    if (peerId) this.knownPeerIds.add(peerId);
  }

  _deepClone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }

  _resetRuntimeState() {
    if (this.trysteroRoom) {
      try { this.trysteroRoom.leave(); } catch (_) {}
      this.trysteroRoom = null;
    }
    this._sendData = null;
    this._trysteroToLogical.clear();
    this._logicalToTrystero.clear();
    this.players.clear();
    this.roomVersion = 0;
    this.currentHostId = null;
    this.previousHostId = null;
    this.playerOrder = [];
    this.roomSnapshot = null;
    this.gameState = null;
    this.backupHostIds = [];
    this.hostMigrationInProgress = false;
    this.lastSnapshotAt = null;
    this.processedMessageIds.clear();
    this._stopSnapshotHeartbeat();
  }

  _clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

window.NetworkManager = NetworkManager;
