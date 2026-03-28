/**
 * NetworkManager — resilient P2P multiplayer networking with dynamic host takeover.
 *
 * Goals:
 * - Keep rooms alive when the current host leaves or drops.
 * - Preserve the same room code across host migration.
 * - Minimise downtime with deterministic backup election.
 * - Keep AI authority out of the host role: the host only coordinates transport.
 * - Sanitize every user-provided string and validate inbound payloads.
 *
 * P2P connectivity
 * -----------------
 * PeerJS can use ICE servers to improve NAT traversal.
 * We configure a public STUN server so WebRTC can discover the best
 * direct path whenever possible. This keeps the app fully P2P while
 * significantly improving reliability on mobile, 4G/5G, and restrictive
 * networks.
 *
 * Architecture
 * ------------
 * Every browser owns its own PeerJS peer id:
 *   yaihb-{roomCode}-{token}
 *
 * The room code is stable. The host is whichever player currently has:
 *   state.currentHostId === myId
 *
 * Joining a room works by trying a small set of likely peer ids for that room:
 * - cached current host id from localStorage
 * - known player ids for that room from localStorage
 *
 * Once connected, the host distributes authoritative room snapshots:
 * {
 *   roomCode,
 *   version,
 *   currentHostId,
 *   createdAt,
 *   playerOrder: [peerId...],
 *   players: [{id, name, joinedAt, isHost}],
 *   gameState: {... arbitrary app snapshot ...}
 * }
 *
 * On host disconnect:
 * - each client computes the same deterministic successor from playerOrder
 * - if it is the successor, it promotes itself to host immediately
 * - others wait briefly, then reconnect to the replacement host id
 *
 * Notes
 * -----
 * - This is still browser P2P, so no trustless anti-cheat guarantees exist.
 * - The host is NOT intended to be game authority for AI moderation.
 * - The questioner should remain the authority for round AI decisions.
 */

class NetworkManager {
  constructor() {
    /** @type {Peer|null} */
    this.peer = null;

    /** @type {Object} PeerJS ICE configuration */
    this.peerConfig = {
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
        ],
      },
    };

    /** @type {Map<string, { conn: any, playerName: string, joinedAt: number }>} */
    this.connections = new Map();

    /** @type {any|null} */
    this.hostConn = null;

    /** @type {boolean} */
    this.isHostPlayer = false;

    /** @type {string|null} */
    this.myId = null;

    /** @type {string|null} */
    this.myName = null;

    /** @type {string|null} */
    this.roomCode = null;

    /** @type {Map<string, {id: string, name: string, isHost: boolean, joinedAt: number}>} */
    this.players = new Map();

    /** @type {Object<string, Function[]>} */
    this.listeners = {};

    /** @type {number} */
    this.roomVersion = 0;

    /** @type {string|null} */
    this.currentHostId = null;

    /** @type {string|null} */
    this.previousHostId = null;

    /** @type {number|null} */
    this.createdAt = null;

    /** @type {string[]} */
    this.playerOrder = [];

    /** @type {Object|null} */
    this.roomSnapshot = null;

    /** @type {Object|null} */
    this.gameState = null;

    /** @type {string[]} */
    this.backupHostIds = [];

    /** @type {boolean} */
    this.joinInProgress = false;

    /** @type {boolean} */
    this.hostMigrationInProgress = false;

    /** @type {boolean} */
    this.manualDisconnect = false;

    /** @type {number|null} */
    this.reconnectTimer = null;

    /** @type {number|null} */
    this.snapshotHeartbeatTimer = null;

    /** @type {number|null} */
    this.lastSnapshotAt = null;

    /** @type {Set<string>} */
    this.knownPeerIds = new Set();

    /** @type {Set<string>} */
    this.processedMessageIds = new Set();

    this.MAX_NAME_LENGTH = 20;
    this.MAX_TEXT_LENGTH = 2000;
    this.MAX_ROOM_CODE_LENGTH = 6;
    this.GLOBAL_ROOM_CODE = "GLOBAL";
    this.SNAPSHOT_HEARTBEAT_MS = 4000;
    this.RECONNECT_DELAY_MS = 900;
    this.RECONNECT_TIMEOUT_MS = 10000;
    this.HOST_OPEN_TIMEOUT_MS = 15000;

    this._handleHostData = this._handleHostData.bind(this);
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
    this.listeners[event] = this.listeners[event].filter(
      (cb) => cb !== callback,
    );
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

  async createRoom(playerName, explicitRoomCode = null) {
    this.manualDisconnect = false;
    this._clearReconnectTimer();
    this._resetRuntimeState();

    const cleanName = this._sanitizeName(playerName) || this._generateAutoName();

    this.myName = cleanName;
    this.roomCode = explicitRoomCode
      ? this._sanitizeRoomCode(explicitRoomCode) || this._generateRoomCode()
      : this._generateRoomCode();
    this.createdAt = Date.now();

    const myPeerId = this._buildPeerId(
      this.roomCode,
      this._generateRandomSuffix(),
    );

    this.emit("connection-status", "connecting");
    console.log(`[Network] Creating room ${this.roomCode} as ${myPeerId}`);

    return new Promise((resolve, reject) => {
      let settled = false;

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimeout);
        fn(value);
      };

      const openTimeout = setTimeout(() => {
        this.emit("connection-status", "error");
        this.emit("error", new Error("Could not open the room connection."));
        this._destroyPeer();
        settle(reject, new Error("Peer open timeout"));
      }, this.HOST_OPEN_TIMEOUT_MS);

      try {
        this.peer = new Peer(myPeerId, this.peerConfig);
      } catch (err) {
        this.emit("connection-status", "error");
        settle(reject, err);
        return;
      }

      this.peer.on("open", (id) => {
        this.myId = id;
        this.isHostPlayer = true;
        this.currentHostId = id;
        this.previousHostId = null;
        this.roomVersion = 1;
        this.playerOrder = [id];

        const now = Date.now();
        this.players.set(id, {
          id,
          name: this.myName,
          isHost: true,
          joinedAt: now,
        });

        this._rememberPeerId(id);
        this._persistRoomCache();

        this.peer.on("connection", (conn) =>
          this._handleIncomingConnection(conn),
        );

        this._publishSnapshot();
        this._startSnapshotHeartbeat();

        this.emit("connection-status", "connected");
        this.emit("connected", { id, roomCode: this.roomCode, isHost: true });
        console.log(`[Network] Room ${this.roomCode} created. Host=${id}`);
        settle(resolve, this.roomCode);
      });

      this.peer.on("error", (err) => {
        clearTimeout(openTimeout);
        console.error("[Network] Peer error while creating room:", err);
        this.emit("connection-status", "error");
        this.emit("error", this._normalizePeerError(err));
        settle(reject, this._normalizePeerError(err));
      });

      this.peer.on("disconnected", () => {
        console.warn(
          "[Network] Host peer lost signalling connection, attempting reconnect...",
        );
        if (this.peer && !this.peer.destroyed) {
          try {
            this.peer.reconnect();
          } catch (_) {}
        }
      });
    });
  }

  async joinRoom(roomCode, playerName) {
    this.manualDisconnect = false;
    this._clearReconnectTimer();
    this._resetRuntimeState();

    const cleanCode = this._sanitizeRoomCode(roomCode);
    const cleanName = this._sanitizeName(playerName) || this._generateAutoName();

    if (!cleanCode) {
      throw new Error("Please enter a valid room code.");
    }
    this.roomCode = cleanCode;
    this.myName = cleanName;
    this.joinInProgress = true;

    const myPeerId = this._buildPeerId(
      this.roomCode,
      this._generateRandomSuffix(),
    );
    this.emit("connection-status", "connecting");
    console.log(`[Network] Joining room ${this.roomCode} as ${myPeerId}`);

    return new Promise((resolve, reject) => {
      let settled = false;

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(joinTimeout);
        this.joinInProgress = false;
        fn(value);
      };

      const joinTimeout = setTimeout(() => {
        this.emit("connection-status", "error");
        this.emit("error", new Error("Could not connect to the room."));
        this._destroyPeer();
        settle(reject, new Error("Join timeout"));
      }, this.RECONNECT_TIMEOUT_MS);

      try {
        this.peer = new Peer(myPeerId, this.peerConfig);
      } catch (err) {
        this.emit("connection-status", "error");
        settle(reject, err);
        return;
      }

      this.peer.on("open", async (id) => {
        this.myId = id;
        this._rememberPeerId(id);

        try {
          const discovered = await this._discoverRoomPeerIds();
          const candidates = this._getCandidateHostIds(discovered);
          const connected = await this._connectToAnyHost(candidates);
          if (!connected) {
            throw new Error("Room not found or host unavailable.");
          }

          this.emit("connection-status", "connected");
          this.emit("connected", {
            id,
            roomCode: this.roomCode,
            isHost: false,
            hostId: this.currentHostId,
          });

          settle(resolve, undefined);
        } catch (err) {
          this.emit("connection-status", "error");
          settle(reject, err);
        }
      });

      this.peer.on("connection", (conn) => {
        // During host migration a client can become host after already opening its peer.
        // Keep this enabled for seamless promotion.
        this._handleIncomingConnection(conn);
      });

      this.peer.on("error", (err) => {
        console.error("[Network] Peer error while joining room:", err);
        this.emit("connection-status", "error");
        settle(reject, this._normalizePeerError(err));
      });

      this.peer.on("disconnected", () => {
        console.warn(
          "[Network] Client peer lost signalling connection, attempting reconnect...",
        );
        if (this.peer && !this.peer.destroyed) {
          try {
            this.peer.reconnect();
          } catch (_) {}
        }
      });
    });
  }

  broadcast(message) {
    const safe = this._sanitizeOutboundMessage(message);
    if (!safe) {
      console.warn(
        "[Network] broadcast() called with invalid message:",
        message,
      );
      return;
    }

    if (this.isHostPlayer) {
      for (const { conn } of this.connections.values()) {
        this._safeSend(conn, safe);
      }
      return;
    }

    if (this.hostConn && this.hostConn.open) {
      this._safeSend(this.hostConn, {
        type: "relay",
        payload: safe,
        _relayId: this._makeMessageId(),
      });
      return;
    }

    console.warn("[Network] Cannot broadcast — no open connection to host.");
  }

  send(peerId, message) {
    const targetId = this._sanitizePeerId(peerId);
    const safe = this._sanitizeOutboundMessage(message);

    if (!targetId || !safe) {
      console.warn("[Network] send() called with invalid target/message.");
      return;
    }

    if (this.isHostPlayer) {
      if (targetId === this.myId) {
        this.emit("message", safe);
        return;
      }

      const entry = this.connections.get(targetId);
      if (entry) {
        this._safeSend(entry.conn, safe);
      } else {
        console.warn(`[Network] send() target ${targetId} not found.`);
      }
      return;
    }

    if (this.hostConn && this.hostConn.open) {
      this._safeSend(this.hostConn, {
        type: "relay-to",
        target: targetId,
        payload: safe,
        _relayId: this._makeMessageId(),
      });
      return;
    }

    console.warn("[Network] Cannot send — no open connection to host.");
  }

  getPlayers() {
    return Array.from(this.players.values()).sort((a, b) => {
      const aIndex = this.playerOrder.indexOf(a.id);
      const bIndex = this.playerOrder.indexOf(b.id);
      return aIndex - bIndex;
    });
  }

  isHost() {
    return this.isHostPlayer;
  }

  getMyId() {
    return this.myId;
  }

  getMyName() {
    return this.myName;
  }

  getCurrentHostId() {
    return this.currentHostId;
  }

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
    } else if (this.hostConn && this.hostConn.open) {
      this._safeSend(this.hostConn, {
        type: "room-state-update",
        state: this.gameState,
      });
    }
  }

  disconnect() {
    this.manualDisconnect = true;
    this._clearReconnectTimer();
    this._stopSnapshotHeartbeat();

    for (const { conn } of this.connections.values()) {
      try {
        conn.close();
      } catch (_) {}
    }
    this.connections.clear();

    if (this.hostConn) {
      try {
        this.hostConn.close();
      } catch (_) {}
      this.hostConn = null;
    }

    this._destroyPeer();

    this.players.clear();
    this.playerOrder = [];
    this.currentHostId = null;
    this.previousHostId = null;
    this.roomSnapshot = null;
    this.gameState = null;
    this.roomVersion = 0;
    this.lastSnapshotAt = null;
    this.isHostPlayer = false;
    this.joinInProgress = false;
    this.hostMigrationInProgress = false;

    this.emit("connection-status", "disconnected");
    this.emit("disconnected", { reason: "Local disconnect" });
  }

  async connectAutoGlobal() {
    const autoName = this._generateAutoName();

    try {
      await this.joinRoom(this.GLOBAL_ROOM_CODE, autoName);
      return {
        roomCode: this.roomCode,
        role: "client",
        playerId: this.myId,
      };
    } catch (joinErr) {
      console.warn("[Network] Auto-join failed, attempting auto-host:", joinErr);
      const roomCode = await this.createRoom(autoName, this.GLOBAL_ROOM_CODE);
      return {
        roomCode,
        role: "host",
        playerId: this.myId,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Incoming connections / client-host handling
  // ---------------------------------------------------------------------------

  _handleIncomingConnection(conn) {
    if (!conn || !conn.peer) return;
    console.log(`[Network] Incoming connection from ${conn.peer}`);

    conn.on("open", () => {
      console.log(`[Network] DataConnection open with ${conn.peer}`);
    });

    let joined = false;

    conn.on("data", (raw) => {
      const data = this._sanitizeIncomingMessage(raw);
      if (!data) return;

      if (!joined) {
        if (data.type === "join" && typeof data.name === "string") {
          if (!this.isHostPlayer) {
            this._safeSend(conn, {
              type: "not-host",
              currentHostId: this.currentHostId,
            });
            try {
              conn.close();
            } catch (_) {}
            return;
          }

          joined = true;
          this._acceptJoiningPeer(conn, data);
        }
        return;
      }

      this._handleHostData(data, conn.peer);
    });

    conn.on("close", () => {
      this._removePlayer(conn.peer);
    });

    conn.on("error", (err) => {
      console.error(`[Network] Connection error with ${conn.peer}:`, err);
      this._removePlayer(conn.peer);
    });
  }

  _acceptJoiningPeer(conn, data) {
    if (!this.isHostPlayer) return;

    const peerId = conn.peer;
    const playerName = this._sanitizeName(data.name) || "Player";
    const joinedAt =
      typeof data.joinedAt === "number" ? data.joinedAt : Date.now();

    if (this.connections.has(peerId)) {
      try {
        this.connections.get(peerId).conn.close();
      } catch (_) {}
      this.connections.delete(peerId);
    }

    this.connections.set(peerId, {
      conn,
      playerName,
      joinedAt,
    });

    if (!this.playerOrder.includes(peerId)) {
      this.playerOrder.push(peerId);
    }

    this.players.set(peerId, {
      id: peerId,
      name: playerName,
      isHost: false,
      joinedAt,
    });

    this._rememberPeerId(peerId);
    this._bumpRoomVersion();
    this._publishSnapshot();
    this.emit("player-joined", { id: peerId, name: playerName, isHost: false });

    // Send a direct welcome/snapshot immediately.
    this._safeSend(conn, {
      type: "room-snapshot",
      snapshot: this._makeSnapshot(),
    });

    console.log(`[Network] Player "${playerName}" joined (${peerId})`);
  }

  _handleHostData(data, senderPeerId) {
    if (!data || typeof data !== "object") return;

    switch (data.type) {
      case "relay": {
        const payload = this._sanitizeIncomingMessage(data.payload);
        if (!payload) return;

        for (const [peerId, { conn }] of this.connections) {
          if (peerId !== senderPeerId) {
            this._safeSend(conn, payload);
          }
        }
        this.emit("message", payload);
        break;
      }

      case "relay-to": {
        const target = this._sanitizePeerId(data.target);
        const payload = this._sanitizeIncomingMessage(data.payload);
        if (!target || !payload) return;

        if (target === this.myId) {
          this.emit("message", payload);
        } else {
          const entry = this.connections.get(target);
          if (entry) {
            this._safeSend(entry.conn, payload);
          }
        }
        break;
      }

      case "room-state-update": {
        if (!this.isHostPlayer) return;
        this.gameState = this._sanitizeGameState(data.state || {});
        this._bumpRoomVersion();
        this._publishSnapshot();
        break;
      }

      case "ping": {
        const entry = this.connections.get(senderPeerId);
        if (entry) {
          this._safeSend(entry.conn, {
            type: "pong",
            ts: Date.now(),
          });
        }
        break;
      }

      default:
        this.emit("message", data);
        break;
    }
  }

  _handleClientData(raw) {
    const data = this._sanitizeIncomingMessage(raw);
    if (!data) return;

    switch (data.type) {
      case "room-snapshot": {
        if (!data.snapshot || typeof data.snapshot !== "object") return;
        this._applySnapshot(data.snapshot);
        break;
      }

      case "player-list": {
        // Backward-compatible support if some module still emits this.
        if (!Array.isArray(data.players)) return;

        const previous = new Map(this.players);
        this.players.clear();
        this.playerOrder = [];

        for (const p of data.players) {
          const cleanId = this._sanitizePeerId(p.id);
          if (!cleanId) continue;

          const cleanName = this._sanitizeName(p.name) || "Player";
          const joinedAt =
            typeof p.joinedAt === "number" ? p.joinedAt : Date.now();

          this.players.set(cleanId, {
            id: cleanId,
            name: cleanName,
            isHost: !!p.isHost,
            joinedAt,
          });
          this.playerOrder.push(cleanId);
        }

        this.currentHostId =
          this.playerOrder.find((id) => {
            const player = this.players.get(id);
            return player && player.isHost;
          }) || null;

        for (const [id, info] of this.players) {
          if (!previous.has(id)) this.emit("player-joined", info);
        }
        for (const [id, info] of previous) {
          if (!this.players.has(id)) this.emit("player-left", info);
        }

        this._persistRoomCache();
        break;
      }

      case "host-migrating": {
        const nextHostId = this._sanitizePeerId(data.nextHostId);
        if (!nextHostId) return;

        this.previousHostId = this.currentHostId;
        this.currentHostId = nextHostId;
        this.hostMigrationInProgress = true;
        this.emit("host-migration-started", {
          previousHostId: this.previousHostId,
          nextHostId,
        });
        break;
      }

      case "pong":
        break;

      default:
        this.emit("message", data);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Host migration
  // ---------------------------------------------------------------------------

  _removePlayer(peerId) {
    const cleanPeerId = this._sanitizePeerId(peerId);
    if (!cleanPeerId) return;

    const wasKnown =
      this.players.has(cleanPeerId) || this.connections.has(cleanPeerId);
    if (!wasKnown) return;

    const info = this.players.get(cleanPeerId) || {
      id: cleanPeerId,
      name: "Unknown",
      isHost: false,
    };

    this.connections.delete(cleanPeerId);
    this.players.delete(cleanPeerId);
    this.playerOrder = this.playerOrder.filter((id) => id !== cleanPeerId);

    const removedHost = cleanPeerId === this.currentHostId;
    console.log(`[Network] Player "${info.name}" left (${cleanPeerId})`);

    if (removedHost) {
      this.previousHostId = cleanPeerId;
    }

    if (this.isHostPlayer) {
      this._reflagHostInPlayers();
      this._bumpRoomVersion();
      this._publishSnapshot();
    }

    this.emit("player-left", {
      id: cleanPeerId,
      name: info.name,
      isHost: !!info.isHost,
    });

    if (removedHost && !this.isHostPlayer && !this.manualDisconnect) {
      this._beginHostTakeover();
    }
  }

  _beginHostTakeover() {
    if (this.hostMigrationInProgress) return;
    this.hostMigrationInProgress = true;

    const failoverCandidates = this._getFailoverCandidates();
    const nextHostId = failoverCandidates[0] || null;
    if (!nextHostId) {
      this.emit(
        "error",
        new Error("Room host left and no backup host was available."),
      );
      this.emit("connection-status", "disconnected");
      this.emit("disconnected", { reason: "No backup host available" });
      return;
    }

    this.previousHostId = this.currentHostId;
    this.currentHostId = nextHostId;

    console.warn(
      `[Network] Host takeover: previous=${this.previousHostId || "none"} next=${nextHostId}`,
    );

    this.emit("host-migration-started", {
      previousHostId: this.previousHostId,
      nextHostId,
    });

    if (nextHostId === this.myId) {
      this._promoteSelfToHost();
      return;
    }

    this._scheduleReconnectToReplacementHosts(failoverCandidates);
  }

  _promoteSelfToHost() {
    if (!this.peer || !this.myId) return;

    console.log("[Network] Promoting self to host");

    this.isHostPlayer = true;
    this.currentHostId = this.myId;
    this.previousHostId = null;
    this.hostMigrationInProgress = false;

    this._reflagHostInPlayers();

    // Close stale connection to previous host.
    if (this.hostConn) {
      try {
        this.hostConn.close();
      } catch (_) {}
      this.hostConn = null;
    }

    this._bumpRoomVersion();
    this._publishSnapshot();
    this._startSnapshotHeartbeat();

    this.emit("host-changed", {
      currentHostId: this.currentHostId,
      isMe: true,
    });
    this.emit("connection-status", "connected");
  }

  _scheduleReconnectToReplacementHosts(candidateHostIds) {
    this._clearReconnectTimer();
    this.emit("connection-status", "connecting");

    this.reconnectTimer = setTimeout(async () => {
      for (const hostId of candidateHostIds) {
        try {
          await this._connectToSpecificHost(hostId);
          this.hostMigrationInProgress = false;
          this.emit("host-changed", {
            currentHostId: hostId,
            isMe: false,
          });
          this.emit("connection-status", "connected");
          return;
        } catch (err) {
          console.warn(
            `[Network] Reconnect attempt failed for replacement host ${hostId}:`,
            err,
          );
        }
      }

      // If all intended replacements failed, recompute again from current knowledge.
      this.hostMigrationInProgress = false;
      this._beginHostTakeover();
    }, this.RECONNECT_DELAY_MS);
  }

  _computeNextHostId() {
    const candidates = this.playerOrder.filter(
      (id) => id && this.players.has(id),
    );
    if (candidates.length === 0) return null;

    const previousHostId = this.currentHostId || this.previousHostId;
    if (!previousHostId) {
      return candidates[0] || null;
    }

    const withoutPrev = candidates.filter((id) => id !== previousHostId);
    if (withoutPrev.length === 0) return null;

    const sorted = withoutPrev.sort((a, b) => {
      const pa = this.players.get(a);
      const pb = this.players.get(b);
      if (!pa || !pb) return a.localeCompare(b);
      if (pa.joinedAt !== pb.joinedAt) return pa.joinedAt - pb.joinedAt;
      return a.localeCompare(b);
    });

    return sorted[0] || null;
  }

  // ---------------------------------------------------------------------------
  // Snapshot handling
  // ---------------------------------------------------------------------------

  _makeSnapshot() {
    return {
      roomCode: this.roomCode,
      version: this.roomVersion,
      currentHostId: this.currentHostId,
      backupHostIds: this._getHostBackupChain(3),
      createdAt: this.createdAt,
      playerOrder: [...this.playerOrder],
      players: this.getPlayers(),
      gameState: this._deepClone(this.gameState || {}),
      updatedAt: Date.now(),
    };
  }

  _publishSnapshot() {
    if (!this.isHostPlayer) return;

    const snapshot = this._makeSnapshot();
    this.roomSnapshot = snapshot;
    this.lastSnapshotAt = Date.now();
    this._persistRoomCache();

    for (const { conn } of this.connections.values()) {
      this._safeSend(conn, {
        type: "room-snapshot",
        snapshot,
      });
    }
  }

  _applySnapshot(snapshot) {
    const safeSnapshot = this._sanitizeSnapshot(snapshot);
    if (!safeSnapshot) return;

    if (safeSnapshot.version < this.roomVersion) return;

    const previousPlayers = new Map(this.players);

    this.roomSnapshot = safeSnapshot;
    this.roomVersion = safeSnapshot.version;
    this.roomCode = safeSnapshot.roomCode;
    this.currentHostId = safeSnapshot.currentHostId;
    this.backupHostIds = Array.isArray(safeSnapshot.backupHostIds)
      ? safeSnapshot.backupHostIds
      : [];
    this.createdAt = safeSnapshot.createdAt;
    this.playerOrder = [...safeSnapshot.playerOrder];
    this.gameState = this._sanitizeGameState(safeSnapshot.gameState || {});
    this.lastSnapshotAt = Date.now();

    this.players.clear();
    for (const p of safeSnapshot.players) {
      this.players.set(p.id, {
        id: p.id,
        name: p.name,
        isHost: !!p.isHost,
        joinedAt: typeof p.joinedAt === "number" ? p.joinedAt : Date.now(),
      });
      this._rememberPeerId(p.id);
    }

    this.isHostPlayer = this.currentHostId === this.myId;

    for (const [id, info] of this.players) {
      if (!previousPlayers.has(id)) this.emit("player-joined", info);
    }
    for (const [id, info] of previousPlayers) {
      if (!this.players.has(id)) this.emit("player-left", info);
    }

    this._persistRoomCache();
  }

  _startSnapshotHeartbeat() {
    this._stopSnapshotHeartbeat();
    this.snapshotHeartbeatTimer = setInterval(() => {
      if (this.isHostPlayer) {
        this._publishSnapshot();
      }
    }, this.SNAPSHOT_HEARTBEAT_MS);
  }

  _stopSnapshotHeartbeat() {
    if (this.snapshotHeartbeatTimer !== null) {
      clearInterval(this.snapshotHeartbeatTimer);
      this.snapshotHeartbeatTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Connecting / reconnecting to hosts
  // ---------------------------------------------------------------------------

  async _connectToAnyHost(candidateIds) {
    const unique = [...new Set(candidateIds.filter(Boolean))];

    for (const candidate of unique) {
      try {
        const ok = await this._connectToSpecificHost(candidate);
        if (ok) return true;
      } catch (err) {
        console.warn(
          `[Network] Failed to connect to candidate host ${candidate}:`,
          err,
        );
      }
    }

    return false;
  }

  async _connectToSpecificHost(hostPeerId) {
    const target = this._sanitizePeerId(hostPeerId);
    if (!this.peer || !target || target === this.myId) {
      throw new Error("Invalid replacement host id.");
    }

    if (this.hostConn) {
      try {
        this.hostConn.close();
      } catch (_) {}
      this.hostConn = null;
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn(value);
      };

      const timeout = setTimeout(() => {
        settle(reject, new Error("Timed out connecting to host."));
      }, this.RECONNECT_TIMEOUT_MS);

      let conn;
      try {
        conn = this.peer.connect(target, { reliable: true });
      } catch (err) {
        settle(reject, err);
        return;
      }

      this.hostConn = conn;

      conn.on("open", () => {
        this.currentHostId = target;
        this.isHostPlayer = false;

        this._safeSend(conn, {
          type: "join",
          name: this.myName,
          joinedAt: this._getOwnJoinedAt(),
        });
      });

      conn.on("data", (data) => {
        const safe = this._sanitizeIncomingMessage(data);
        if (!safe) return;

        if (safe.type === "room-snapshot") {
          this._handleClientData(safe);
          settle(resolve, true);
          return;
        }

        if (safe.type === "not-host") {
          const hintedHost = this._sanitizePeerId(safe.currentHostId);
          if (hintedHost && hintedHost !== target && hintedHost !== this.myId) {
            settle(reject, new Error(`Redirected to another host: ${hintedHost}`));
            return;
          }
          settle(reject, new Error("Connected peer is not the room host."));
          return;
        }

        this._handleClientData(safe);
      });

      conn.on("close", () => {
        console.warn("[Network] Connection to host closed.");
        this.hostConn = null;

        if (!this.manualDisconnect) {
          this._beginHostTakeover();
        }
      });

      conn.on("error", (err) => {
        if (this.hostConn === conn) {
          this.hostConn = null;
        }
        settle(reject, err);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _buildPeerId(roomCode, token) {
    return `yaihb-${roomCode}-${token}`;
  }

  _generateRoomCode() {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < this.MAX_ROOM_CODE_LENGTH; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  _generateRandomSuffix() {
    const chars = "abcdefghijkmnpqrstuvwxyz23456789";
    let suffix = "";
    for (let i = 0; i < 8; i++) {
      suffix += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return suffix;
  }

  _generateAutoName() {
    const n = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0");
    return `Player-${n}`;
  }

  _sanitizeName(name) {
    if (typeof name !== "string") return "";
    let value = name
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (value.length > this.MAX_NAME_LENGTH) {
      value = value.slice(0, this.MAX_NAME_LENGTH).trim();
    }

    return value;
  }

  _sanitizeText(text, maxLength = this.MAX_TEXT_LENGTH) {
    if (typeof text !== "string") return "";
    let value = text
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .trim();

    if (value.length > maxLength) {
      value = value.slice(0, maxLength);
    }

    return value;
  }

  _sanitizeRoomCode(code) {
    if (typeof code !== "string") return "";
    const clean = code
      .toUpperCase()
      .replace(/[^A-Z2-9]/g, "")
      .slice(0, this.MAX_ROOM_CODE_LENGTH);
    return clean;
  }

  _sanitizePeerId(id) {
    if (typeof id !== "string") return null;
    const clean = id.trim();
    if (!/^yaihb-[A-Z2-9]{6}-[a-z2-9]{8}$/i.test(clean)) return null;
    return clean;
  }

  _sanitizeOutgoingMessageValue(value, depth = 0) {
    if (depth > 8) return null;
    if (value == null) return value;
    if (typeof value === "string") return this._sanitizeText(value);
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value;

    if (Array.isArray(value)) {
      return value
        .slice(0, 100)
        .map((item) => this._sanitizeOutgoingMessageValue(item, depth + 1));
    }

    if (typeof value === "object") {
      const out = {};
      const entries = Object.entries(value).slice(0, 100);
      for (const [k, v] of entries) {
        if (typeof k !== "string") continue;
        out[k] = this._sanitizeOutgoingMessageValue(v, depth + 1);
      }
      return out;
    }

    return null;
  }

  _sanitizeOutboundMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message))
      return null;
    if (typeof message.type !== "string" || !message.type.trim()) return null;

    const safe = this._sanitizeOutgoingMessageValue(message);
    safe.type = this._sanitizeText(message.type, 64);

    if (!safe._msgId) {
      safe._msgId = this._makeMessageId();
    }

    return safe;
  }

  _sanitizeIncomingMessage(message) {
    const safe = this._sanitizeOutboundMessage(message);
    if (!safe) return null;

    if (safe._msgId && this.processedMessageIds.has(safe._msgId)) {
      return safe;
    }

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

    const roomCode = this._sanitizeRoomCode(snapshot.roomCode);
    const currentHostId = this._sanitizePeerId(snapshot.currentHostId);
    const createdAt =
      typeof snapshot.createdAt === "number" ? snapshot.createdAt : Date.now();
    const version = typeof snapshot.version === "number" ? snapshot.version : 0;

    if (!roomCode || !currentHostId) return null;

    const playerOrder = Array.isArray(snapshot.playerOrder)
      ? snapshot.playerOrder
          .map((id) => this._sanitizePeerId(id))
          .filter(Boolean)
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
              joinedAt:
                typeof p.joinedAt === "number" ? p.joinedAt : Date.now(),
            };
          })
          .filter(Boolean)
      : [];

    const backupHostIds = Array.isArray(snapshot.backupHostIds)
      ? snapshot.backupHostIds
          .map((id) => this._sanitizePeerId(id))
          .filter(Boolean)
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
      updatedAt:
        typeof snapshot.updatedAt === "number"
          ? snapshot.updatedAt
          : Date.now(),
    };
  }

  _sanitizeGameState(state) {
    return this._sanitizeOutgoingMessageValue(state || {}, 0) || {};
  }

  _makeMessageId() {
    const a = Math.random().toString(36).slice(2, 8);
    const b = Date.now().toString(36);
    return `${b}-${a}`;
  }

  _normalizePeerError(err) {
    if (!err) return new Error("Unknown network error.");

    if (err instanceof Error) {
      if (err.type === "peer-unavailable") {
        return new Error("Room not found or replacement host unavailable.");
      }
      if (err.type === "unavailable-id") {
        return new Error("This room id is already in use.");
      }
      if (err.type === "network" || err.type === "server-error") {
        return new Error("Could not reach the PeerJS server.");
      }
      return err;
    }

    return new Error(typeof err === "string" ? err : "Unknown network error.");
  }

  _safeSend(conn, data) {
    try {
      if (conn && conn.open) {
        conn.send(data);
      }
    } catch (err) {
      console.error("[Network] Send failed:", err);
    }
  }

  _destroyPeer() {
    if (!this.peer) return;
    try {
      this.peer.destroy();
    } catch (_) {}
    this.peer = null;
  }

  _bumpRoomVersion() {
    this.roomVersion += 1;
  }

  _reflagHostInPlayers() {
    for (const [id, player] of this.players) {
      this.players.set(id, {
        ...player,
        isHost: id === this.currentHostId,
      });
    }
  }

  _rememberPeerId(peerId) {
    const clean = this._sanitizePeerId(peerId);
    if (!clean) return;
    this.knownPeerIds.add(clean);
  }

  _roomCacheKey() {
    return this.roomCode ? `yaihb-room-${this.roomCode}` : null;
  }

  _persistRoomCache() {
    try {
      const key = this._roomCacheKey();
      if (!key) return;

      const payload = {
        roomCode: this.roomCode,
        currentHostId: this.currentHostId,
        knownPeerIds: [...this.knownPeerIds].filter((id) =>
          id.includes(`yaihb-${this.roomCode}-`),
        ),
        playerOrder: [...this.playerOrder],
        snapshot: this.roomSnapshot,
        updatedAt: Date.now(),
      };

      localStorage.setItem(key, JSON.stringify(payload));
    } catch (_) {}
  }

  _readRoomCache() {
    try {
      const key = this._roomCacheKey();
      if (!key) return null;
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  _getCandidateHostIds(discoveredPeerIds = []) {
    const candidates = [];
    const cache = this._readRoomCache();

    if (cache && cache.currentHostId) candidates.push(cache.currentHostId);
    if (this.currentHostId) candidates.push(this.currentHostId);

    if (cache && Array.isArray(cache.playerOrder)) {
      for (const id of cache.playerOrder) candidates.push(id);
    }

    if (cache && Array.isArray(cache.knownPeerIds)) {
      for (const id of cache.knownPeerIds) candidates.push(id);
    }

    for (const id of this.knownPeerIds) {
      candidates.push(id);
    }

    if (Array.isArray(discoveredPeerIds)) {
      for (const id of discoveredPeerIds) {
        candidates.push(id);
      }
    }

    return candidates
      .map((id) => this._sanitizePeerId(id))
      .filter(Boolean)
      .filter((id) => id !== this.myId);
  }

  async _discoverRoomPeerIds() {
    if (!this.peer || typeof this.peer.listAllPeers !== "function") {
      return [];
    }

    const prefix = `yaihb-${this.roomCode}-`;

    return new Promise((resolve) => {
      let done = false;

      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
      };

      const timeout = setTimeout(() => finish([]), 1800);

      try {
        this.peer.listAllPeers((peerIds) => {
          clearTimeout(timeout);
          if (!Array.isArray(peerIds)) {
            finish([]);
            return;
          }

          const filtered = peerIds
            .filter((id) => typeof id === "string" && id.startsWith(prefix))
            .map((id) => this._sanitizePeerId(id))
            .filter(Boolean)
            .filter((id) => id !== this.myId);

          finish(filtered);
        });
      } catch (_) {
        clearTimeout(timeout);
        finish([]);
      }
    });
  }

  _getHostBackupChain(maxBackups = 3) {
    const currentHostId = this.currentHostId;
    const ordered = this.playerOrder
      .filter((id) => id && this.players.has(id) && id !== currentHostId)
      .sort((a, b) => {
        const pa = this.players.get(a);
        const pb = this.players.get(b);
        if (!pa || !pb) return a.localeCompare(b);
        if (pa.joinedAt !== pb.joinedAt) return pa.joinedAt - pb.joinedAt;
        return a.localeCompare(b);
      });

    return ordered.slice(0, Math.max(1, maxBackups));
  }

  _getFailoverCandidates() {
    const next = [];

    if (Array.isArray(this.backupHostIds)) {
      for (const id of this.backupHostIds) {
        const clean = this._sanitizePeerId(id);
        if (clean && clean !== this.previousHostId) {
          next.push(clean);
        }
      }
    }

    const computed = this._getHostBackupChain(5);
    for (const id of computed) {
      if (id && !next.includes(id)) {
        next.push(id);
      }
    }

    return next;
  }

  _getOwnJoinedAt() {
    const me = this.myId ? this.players.get(this.myId) : null;
    return me && typeof me.joinedAt === "number" ? me.joinedAt : Date.now();
  }

  _deepClone(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return null;
    }
  }

  _resetRuntimeState() {
    this.connections.clear();
    this.hostConn = null;
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
