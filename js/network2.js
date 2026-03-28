/**
 * NetworkManager v2 — Serverless P2P via Trystero.
 * Fallback to localStorage polling for local testing.
 */

class NetworkManager {
  constructor() {
    this._joinRoomFn = null;
    this.trysteroRoom = null;
    this._sendData = null;
    this._trysteroToLogical = new Map();
    this._logicalToTrystero = new Map();
    this.players = new Map();
    this.listeners = {};
    this.roomVersion = 0;
    this.myId = null;
    this.myName = null;
    this.roomCode = "GLOBAL";
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
    this.TRYSTERO_APP_ID = "youraihateboresme-v1";
    this.TRYSTERO_ROOM_ID = "global";
    this.HANDSHAKE_WAIT_MS = 2000;
    this.SNAPSHOT_HEARTBEAT_MS = 4000;
    this.useFallback = false;
  }

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
      try { cb(...args); } catch (err) {
        console.error(`[Network] Error in "${event}" listener:`, err);
      }
    }
  }

  async connectAutoGlobal() {
    this.manualDisconnect = false;
    this._clearReconnectTimer();
    this._resetRuntimeState();
    this.myId = this._generatePeerId();
    this.myName = this._generateAutoName();
    this.createdAt = Date.now();
    this.emit("connection-status", "connecting");
    console.log(`[Network] connectAutoGlobal — myId=${this.myId}`);

    try {
      await this._loadTrystero();
      await this._joinTrysteroRoom();
    } catch (err) {
      console.warn("[Network] Trystero failed, using localStorage fallback:", err.message);
      this.useFallback = true;
      this._joinLocalStorageRoom();
    }

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
      this._trysteroSend(safe);
      return;
    }
    const hostTid = this._logicalToTrystero.get(this.currentHostId);
    if (hostTid) {
      this._trysteroSend({ type: "relay", payload: safe, _relayId: this._makeMessageId() }, [hostTid]);
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
      if (targetTid) this._trysteroSend(safe, [targetTid]);
      return;
    }
    const hostTid = this._logicalToTrystero.get(this.currentHostId);
    if (hostTid) {
      this._trysteroSend({ type: "relay-to", target: targetId, payload: safe, _relayId: this._makeMessageId() }, [hostTid]);
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
  getRoomSnapshot() { return this.roomSnapshot ? this._deepClone(this.roomSnapshot) : null; }

  updateGameState(partialState = {}) {
    if (!partialState || typeof partialState !== "object") return;
    this.gameState = {
      ...(this.gameState || {}),
      ...this._sanitizeGameState(partialState),
      updatedAt: Date.now(),
      updatedBy: this.myId,
    };
    if (this.isHostPlayer) this._publishSnapshot();
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
    this.roomSnapshot = null;
    this.gameState = null;
    this.isHostPlayer = false;
    this.emit("connection-status", "disconnected");
  }

  // ===== Trystero =====

  async _loadTrystero() {
    if (this._joinRoomFn) return;
    console.log("[Network] Loading Trystero...");

    const urls = [
      "https://esm.run/@trystero-p2p/torrent",
      "https://esm.sh/@trystero-p2p/torrent?bundle",
    ];

    for (const url of urls) {
      try {
        console.log(`[Network] Trying ${url}...`);
        const mod = await Promise.race([
          import(url),
          new Promise((_, r) => setTimeout(() => r(new Error("import timeout")), 8000)),
        ]);
        const fn = mod?.joinRoom || mod?.default?.joinRoom || (typeof mod?.default === "function" ? mod.default : null);
        if (typeof fn === "function") {
          this._joinRoomFn = fn;
          console.log(`[Network] ✓ Trystero loaded from ${url}`);
          return;
        }
      } catch (e) {
        console.warn(`[Network] Import from ${url} failed:`, e?.message);
      }
    }

    throw new Error("Trystero import failed from all CDNs");
  }

  async _joinTrysteroRoom() {
    if (!this._joinRoomFn) throw new Error("_joinRoomFn not set");

    const room = this._joinRoomFn({ appId: this.TRYSTERO_APP_ID }, this.TRYSTERO_ROOM_ID);
    if (!room) throw new Error("joinRoom returned falsy");

    this.trysteroRoom = room;
    const [sendData, getData] = room.makeAction("data");
    this._sendData = sendData;

    this.players.set(this.myId, {
      id: this.myId,
      name: this.myName,
      isHost: false,
      joinedAt: this.createdAt,
    });
    this.playerOrder = [this.myId];

    room.onPeerJoin((tid) => this._onPeerJoin(tid));
    room.onPeerLeave((tid) => this._onPeerLeave(tid));
    getData((data, tid) => this._onData(data, tid));

    await new Promise((r) => setTimeout(r, this.HANDSHAKE_WAIT_MS));
    this._electHost();

    this.emit("connection-status", "connected");
    this.emit("connected", { id: this.myId, roomCode: this.roomCode, isHost: this.isHostPlayer });

    if (this.isHostPlayer) {
      this._startSnapshotHeartbeat();
      this._publishSnapshot();
    }
  }

  _onPeerJoin(tid) {
    console.log(`[Network] Peer joined: ${tid}`);
    this._trysteroSend({
      type: "hello",
      peerId: this.myId,
      name: this.myName,
      joinedAt: this.createdAt,
      currentHostId: this.currentHostId,
    }, [tid]);

    if (this.isHostPlayer) {
      this._trysteroSend({ type: "room-snapshot", snapshot: this._makeSnapshot() }, [tid]);
    }
  }

  _onPeerLeave(tid) {
    const lid = this._trysteroToLogical.get(tid);
    this._trysteroToLogical.delete(tid);
    if (lid) this._logicalToTrystero.delete(lid);
    if (lid) this._removePlayer(lid);
  }

  _onData(raw, tid) {
    const data = this._sanitizeIncomingMessage(raw);
    if (!data) return;

    switch (data.type) {
      case "hello":
        this._handleHello(data, tid);
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
        const senderLogical = this._trysteroToLogical.get(tid);
        for (const [lid, ltid] of this._logicalToTrystero) {
          if (lid !== senderLogical) this._trysteroSend(payload, [ltid]);
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
          const ltid = this._logicalToTrystero.get(target);
          if (ltid) this._trysteroSend(payload, [ltid]);
        }
        break;
      }
      default:
        this.emit("message", data);
        break;
    }
  }

  _handleHello(data, tid) {
    const lid = this._sanitizePeerId(data.peerId);
    if (!lid || lid === this.myId) return;

    this._trysteroToLogical.set(tid, lid);
    this._logicalToTrystero.set(lid, tid);

    const name = this._sanitizeName(data.name) || "Player";
    const joinedAt = typeof data.joinedAt === "number" ? data.joinedAt : Date.now();

    if (!this.players.has(lid)) {
      const info = { id: lid, name, isHost: false, joinedAt };
      this.players.set(lid, info);
      if (!this.playerOrder.includes(lid)) this.playerOrder.push(lid);
      this._rememberPeerId(lid);
      this._bumpRoomVersion();
      this.emit("player-joined", info);

      if (this.isHostPlayer) {
        this._reflagHostInPlayers();
        this._publishSnapshot();
      }
    }

    if (!this.currentHostId || (this.isHostPlayer && joinedAt < this.createdAt)) {
      this._electHost();
    }
  }

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

  _removePlayer(lid) {
    const clean = this._sanitizePeerId(lid);
    if (!clean || !this.players.has(clean)) return;

    const info = this.players.get(clean);
    const wasHost = clean === this.currentHostId;

    this.players.delete(clean);
    this.playerOrder = this.playerOrder.filter((id) => id !== clean);

    console.log(`[Network] Player "${info.name}" left`);
    this.emit("player-left", { id: clean, name: info.name });

    if (wasHost) {
      this.previousHostId = clean;
      this.currentHostId = null;
      this.isHostPlayer = false;
      this._stopSnapshotHeartbeat();
      this._electHost();
    } else if (this.isHostPlayer) {
      this._bumpRoomVersion();
      this._publishSnapshot();
    }
  }

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

    const prevPlayers = new Map(this.players);
    this.roomSnapshot = safe;
    this.roomVersion = safe.version;
    this.currentHostId = safe.currentHostId;
    this.backupHostIds = safe.backupHostIds || [];
    this.playerOrder = [...safe.playerOrder];
    this.gameState = this._sanitizeGameState(safe.gameState || {});

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

    for (const [id] of this.players) {
      if (!prevPlayers.has(id)) this.emit("player-joined", this.players.get(id));
    }
    for (const [id] of prevPlayers) {
      if (!this.players.has(id)) this.emit("player-left", prevPlayers.get(id));
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

  // ===== localStorage Fallback =====

  _joinLocalStorageRoom() {
    console.log("[Network] Using localStorage fallback for local testing");
    this.players.set(this.myId, {
      id: this.myId,
      name: this.myName,
      isHost: false,
      joinedAt: this.createdAt,
    });
    this.playerOrder = [this.myId];

    // Poll localStorage for other players
    this._pollLocalStoragePeers();

    this._electHost();
    this.emit("connection-status", "connected");
    this.emit("connected", { id: this.myId, roomCode: this.roomCode, isHost: this.isHostPlayer });

    if (this.isHostPlayer) {
      this._startSnapshotHeartbeat();
      this._publishSnapshot();
    }
  }

  _pollLocalStoragePeers() {
    setInterval(() => {
      try {
        const stored = localStorage.getItem(`yhb-room-${this.roomCode}`);
        if (!stored) {
          localStorage.setItem(`yhb-room-${this.roomCode}`, JSON.stringify(this.getPlayers()));
          return;
        }
        const data = JSON.parse(stored);
        if (Array.isArray(data)) {
          for (const p of data) {
            const lid = this._sanitizePeerId(p.id);
            if (lid && lid !== this.myId && !this.players.has(lid)) {
              this.players.set(lid, p);
              if (!this.playerOrder.includes(lid)) this.playerOrder.push(lid);
              this.emit("player-joined", p);
              this._electHost();
            }
          }
        }
        localStorage.setItem(`yhb-room-${this.roomCode}`, JSON.stringify(this.getPlayers()));
      } catch (_) {}
    }, 1000);
  }

  // ===== Sanitization =====

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

  _sanitizePeerId(id) {
    if (typeof id !== "string") return null;
    const clean = id.trim().toLowerCase();
    if (!/^yhb-[0-9a-f]{16}$/.test(clean)) return null;
    return clean;
  }

  _sanitizeName(name) {
    if (typeof name !== "string") return "";
    let v = name.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
    return v.length > this.MAX_NAME_LENGTH ? v.slice(0, this.MAX_NAME_LENGTH).trim() : v;
  }

  _sanitizeText(text, max = this.MAX_TEXT_LENGTH) {
    if (typeof text !== "string") return "";
    let v = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
    return v.length > max ? v.slice(0, max) : v;
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
    const roomCode = typeof snapshot.roomCode === "string" ? snapshot.roomCode.slice(0, 10) : "GLOBAL";
    const createdAt = typeof snapshot.createdAt === "number" ? snapshot.createdAt : Date.now();
    const version = typeof snapshot.version === "number" ? snapshot.version : 0;
    if (!currentHostId) return null;

    const playerOrder = Array.isArray(snapshot.playerOrder) ? snapshot.playerOrder.map((id) => this._sanitizePeerId(id)).filter(Boolean) : [];
    const players = Array.isArray(snapshot.players) ? snapshot.players.map((p) => {
      const id = this._sanitizePeerId(p && p.id);
      if (!id) return null;
      return {
        id,
        name: this._sanitizeName(p.name) || "Player",
        isHost: !!p.isHost,
        joinedAt: typeof p.joinedAt === "number" ? p.joinedAt : Date.now(),
      };
    }).filter(Boolean) : [];

    const backupHostIds = Array.isArray(snapshot.backupHostIds) ? snapshot.backupHostIds.map((id) => this._sanitizePeerId(id)).filter(Boolean) : [];

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
