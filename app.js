const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isController = params.get("controller") === "1";

const colors = ["#66e6ff", "#b9ff62", "#ff6f91", "#ffc857"];
const adjectives = ["Turbo", "Laser", "Rocket", "Mighty", "Disco", "Cosmic"];
const nouns = ["Ace", "Rally", "Volley", "Topspin", "Spark", "Serve"];

const tv = {
  view: $("tvView"),
  root: $("gameRoot"),
  lobby: $("lobbyPanel"),
  code: $("gameCode"),
  copy: $("copyLink"),
  status: $("connectionStatus"),
  modeAi: $("modeAi"),
  modePeople: $("modePeople"),
  testStatus: $("testStatus"),
  testMeter: $("testMeterFill"),
  players: $("playersList"),
  start: $("startGame"),
  hud: $("hud"),
  score: $("score"),
  streak: $("streak"),
  timer: $("timer"),
  result: $("resultPanel"),
  finalScore: $("finalScore"),
  resultLine: $("resultLine"),
  playAgain: $("playAgain"),
};

const phone = {
  view: $("phoneView"),
  connect: $("phoneConnect"),
  panel: $("controllerPanel"),
  code: $("codeInput"),
  name: $("nameInput"),
  join: $("joinGame"),
  status: $("phoneStatus"),
  controllerName: $("controllerName"),
  permission: $("permissionButton"),
  swing: $("swingButton"),
  meter: $("meterFill"),
  readout: $("motionReadout"),
  hint: $("controllerHint"),
};

let peer;
let myConn;
let hostCode = "";
let audioReady = false;
let phaserGame;
let sceneRef;
let localHostChannel;
let localControllerChannel;
let localControllerId;
let relayClient;
let relayCode = "";
let relayControllerId = "";
let relayConfirmed = false;

const game = {
  mode: "lobby",
  players: [],
  connections: [],
  playMode: "ai",
  score: 0,
  aiScore: 0,
  sideScores: [0, 0],
  streak: 0,
  timeLeft: 60,
  spawnTimer: 1,
};

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function randomName() {
  return `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`;
}

function modeLink(code = hostCode) {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("controller", "1");
  url.searchParams.set("code", code);
  return url.toString();
}

function ensureAudio() {
  if (audioReady) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  window.motionAudio = window.motionAudio || new AudioContext();
  audioReady = true;
}

function tone(freq, length = 0.08, type = "sine", volume = 0.08) {
  if (!window.motionAudio) return;
  const osc = motionAudio.createOscillator();
  const gain = motionAudio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = volume;
  gain.gain.exponentialRampToValueAtTime(0.001, motionAudio.currentTime + length);
  osc.connect(gain);
  gain.connect(motionAudio.destination);
  osc.start();
  osc.stop(motionAudio.currentTime + length);
}

function buzz(pattern = 30) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

function relayBase(code) {
  return `phone-tennis/${code.toLowerCase()}`;
}

function safeJson(data) {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}

function encodeUtf8(text) {
  return new TextEncoder().encode(text);
}

function encodeString(text) {
  const data = encodeUtf8(text);
  return [data.length >> 8, data.length & 255, ...data];
}

function encodeLength(length) {
  const bytes = [];
  do {
    let digit = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) digit |= 128;
    bytes.push(digit);
  } while (length > 0);
  return bytes;
}

class TinyMqtt {
  constructor(clientId) {
    this.clientId = clientId;
    this.packetId = 1;
    this.handlers = new Map();
    this.connected = false;
    this.connect();
  }

  connect() {
    this.socket = new WebSocket("wss://broker.hivemq.com:8884/mqtt");
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("open", () => this.sendConnect());
    this.socket.addEventListener("message", (event) => this.readPacket(new Uint8Array(event.data)));
    this.socket.addEventListener("close", () => {
      this.connected = false;
      setTimeout(() => this.connect(), 2000);
    });
  }

  send(type, body) {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(new Uint8Array([type, ...encodeLength(body.length), ...body]));
  }

  sendConnect() {
    const body = [
      ...encodeString("MQTT"),
      4,
      2,
      0,
      30,
      ...encodeString(this.clientId),
    ];
    this.send(0x10, body);
  }

  subscribe(topic, handler) {
    this.handlers.set(topic, handler);
    const id = this.packetId++;
    const body = [id >> 8, id & 255, ...encodeString(topic), 0];
    this.send(0x82, body);
  }

  publish(topic, text) {
    const payload = encodeUtf8(text);
    this.send(0x30, [...encodeString(topic), ...payload]);
  }

  readPacket(bytes) {
    const type = bytes[0] >> 4;
    let multiplier = 1;
    let value = 0;
    let offset = 1;
    let digit = 0;
    do {
      digit = bytes[offset++];
      value += (digit & 127) * multiplier;
      multiplier *= 128;
    } while ((digit & 128) !== 0);

    if (type === 2) {
      this.connected = true;
      this.onconnect?.();
      return;
    }

    if (type !== 3) return;
    const topicLength = (bytes[offset] << 8) + bytes[offset + 1];
    offset += 2;
    const topic = new TextDecoder().decode(bytes.slice(offset, offset + topicLength));
    offset += topicLength;
    const payload = new TextDecoder().decode(bytes.slice(offset, 1 + encodeLength(value).length + value));
    this.handlers.get(topic)?.(payload);
  }
}

function setViews() {
  tv.view.hidden = isController;
  phone.view.hidden = !isController;
}

class MatchScene extends Phaser.Scene {
  constructor() {
    super("match");
    this.balls = [];
    this.particles = [];
    this.playerSprites = new Map();
    this.elapsed = 0;
    this.pulse = 0;
  }

  create() {
    sceneRef = this;
    this.bg = this.add.graphics();
    this.trails = this.add.graphics();
    this.targetLayer = this.add.graphics();
    this.particleLayer = this.add.graphics();
    this.prompt = this.add.text(0, 0, "", {
      fontFamily: "system-ui",
      fontSize: "34px",
      fontStyle: "900",
      color: "#ffffff",
      align: "center",
    }).setOrigin(0.5);
    this.promptSub = this.add.text(0, 0, "", {
      fontFamily: "system-ui",
      fontSize: "20px",
      fontStyle: "700",
      color: "rgba(255,255,255,0.68)",
      align: "center",
    }).setOrigin(0.5);
    this.add.keyboard?.on("keydown-SPACE", () => {
      if (game.mode === "playing" && game.players[0]) registerSwing(game.players[0], 1.1);
    });
  }

  lane(index, total = Math.max(1, game.players.length)) {
    const sideMode = game.playMode === "people" && total > 1;
    const laneWidth = sideMode ? this.scale.width : this.scale.width / total;
    const sideY = sideMode && index === 1 ? this.scale.height * 0.2 : this.scale.height * 0.82;
    return {
      x: sideMode ? this.scale.width * 0.5 : laneWidth * index + laneWidth / 2,
      y: sideY,
      width: laneWidth,
    };
  }

  syncPlayers() {
    for (const player of game.players) {
      if (this.playerSprites.has(player.id)) continue;
      const group = this.add.container(0, 0);
      const shadow = this.add.ellipse(0, 34, 138, 48, 0x06121e, 0.48);
      const body = this.add.circle(0, 0, 30, Phaser.Display.Color.HexStringToColor(player.color).color);
      const eyes = this.add.graphics();
      const arc = this.add.graphics();
      const label = this.add.text(0, 72, player.name, {
        fontFamily: "system-ui",
        fontSize: "18px",
        fontStyle: "800",
        color: "#ffffff",
      }).setOrigin(0.5);
      group.add([shadow, body, eyes, arc, label]);
      this.playerSprites.set(player.id, { group, body, eyes, arc, label });
    }

    game.players.forEach((player, index) => {
      const sprite = this.playerSprites.get(player.id);
      if (!sprite) return;
      const lane = this.lane(index);
      sprite.group.setPosition(lane.x, lane.y);
      sprite.group.setScale(lane.y < this.scale.height * 0.5 ? 0.82 : 1);
      sprite.group.setAlpha(player.connected === false ? 0.35 : 1);
      sprite.label.setText(player.name);
      sprite.body.setFillStyle(Phaser.Display.Color.HexStringToColor(player.color).color);
      const size = 30 + (player.energy || 0) * 7;
      sprite.body.setRadius(size);
      sprite.eyes.clear();
      sprite.eyes.fillStyle(0x06121e, 1);
      sprite.eyes.fillCircle(-9, -4, 3);
      sprite.eyes.fillCircle(9, -4, 3);
      sprite.arc.clear();
      sprite.arc.lineStyle(9, Phaser.Display.Color.HexStringToColor(player.color).color, 1);
      const swing = player.swingFlash || 0;
      sprite.arc.beginPath();
      sprite.arc.arc(0, -10, 58 + swing * 42, -0.75, 0.75, false);
      sprite.arc.strokePath();
    });

    this.drawAiOpponent();
  }

  drawAiOpponent() {
    if (game.playMode !== "ai" || game.mode === "lobby") {
      if (this.aiGroup) this.aiGroup.setVisible(false);
      return;
    }
    if (!this.aiGroup) {
      const group = this.add.container(0, 0);
      const shadow = this.add.ellipse(0, 28, 118, 38, 0x06121e, 0.34);
      const body = this.add.circle(0, 0, 25, 0xffc857, 1);
      const racket = this.add.graphics();
      const label = this.add.text(0, 58, "AI Rival", {
        fontFamily: "system-ui",
        fontSize: "16px",
        fontStyle: "800",
        color: "#ffffff",
      }).setOrigin(0.5);
      group.add([shadow, body, racket, label]);
      this.aiGroup = group;
      this.aiRacket = racket;
    }
    this.aiGroup.setVisible(true);
    this.aiGroup.setPosition(this.scale.width * 0.5, this.scale.height * 0.19);
    this.aiRacket.clear();
    this.aiRacket.lineStyle(7, 0xffc857, 1);
    this.aiRacket.beginPath();
    this.aiRacket.arc(0, -6, 48 + Math.sin(this.elapsed * 4) * 5, 2.35, 3.9, false);
    this.aiRacket.strokePath();
  }

  spawnBall() {
    this.resetRallyBall();
  }

  resetRallyBall(targetIndex = 0, fromFar = true) {
    if (!game.players.length) return;
    if (!this.rallyBall) {
      const shadow = this.add.ellipse(0, 0, 42, 18, 0x06121e, 0.34);
      const glow = this.add.circle(0, 0, 30, 0xb9ff62, 0.22);
      const body = this.add.circle(0, 0, 18, 0xf9fbff, 1);
      const stripe = this.add.graphics();
      this.rallyBall = { shadow, glow, body, stripe };
    }
    const playerCount = game.playMode === "people" ? Math.min(game.players.length, 2) : 1;
    const target = game.playMode === "people" ? targetIndex % Math.max(1, playerCount) : 0;
    Object.assign(this.rallyBall, {
      active: true,
      targetIndex: target,
      travel: fromFar ? 0.08 : 0.92,
      direction: fromFar ? 1 : -1,
      speed: 0.28 + Math.min(0.12, game.score / 1800),
      xCurve: (Math.random() - 0.5) * 0.18,
      spin: Math.random() * Math.PI * 2,
      hittable: false,
      bounced: false,
      waiting: false,
    });
  }

  burst(x, y, color, count = 16) {
    const tint = Phaser.Display.Color.HexStringToColor(color).color;
    for (let i = 0; i < count; i += 1) {
      const dot = this.add.circle(x, y, 5, tint, 1);
      this.particles.push({
        dot,
        vx: (Math.random() - 0.5) * 320,
        vy: -90 - Math.random() * 260,
        life: 0.55 + Math.random() * 0.3,
      });
    }
  }

  drawArena() {
    const w = this.scale.width;
    const h = this.scale.height;
    this.bg.clear();
    const top = Phaser.Display.Color.HexStringToColor("#093450").color;
    const mid = Phaser.Display.Color.HexStringToColor("#137056").color;
    this.bg.fillGradientStyle(top, top, mid, 0x21345d, 1);
    this.bg.fillRect(0, 0, w, h);

    const courtX = w * 0.14;
    const courtY = h * 0.18;
    const courtW = w * 0.72;
    const courtH = h * 0.68;
    const netY = courtY + courtH * 0.48;
    const farLeft = w * 0.33;
    const farRight = w * 0.67;
    const nearLeft = w * 0.09;
    const nearRight = w * 0.91;
    const farY = h * 0.18;
    const nearY = h * 0.88;
    this.bg.fillStyle(0x1d8f6b, 0.48);
    this.bg.beginPath();
    this.bg.moveTo(farLeft, farY);
    this.bg.lineTo(farRight, farY);
    this.bg.lineTo(nearRight, nearY);
    this.bg.lineTo(nearLeft, nearY);
    this.bg.closePath();
    this.bg.fillPath();
    this.bg.lineStyle(5, 0xf9fbff, 0.5);
    this.bg.strokePath();
    this.bg.lineStyle(3, 0xf9fbff, 0.38);
    this.bg.lineBetween(w * 0.5, farY, w * 0.5, nearY);
    this.bg.lineBetween(w * 0.41, farY + 30, w * 0.26, nearY - 42);
    this.bg.lineBetween(w * 0.59, farY + 30, w * 0.74, nearY - 42);
    this.bg.lineBetween(w * 0.23, h * 0.55, w * 0.77, h * 0.55);
    this.bg.lineStyle(9, 0xffffff, 0.7);
    this.bg.lineBetween(w * 0.2, netY, w * 0.8, netY);
    this.bg.lineStyle(2, 0x06121e, 0.3);
    for (let x = w * 0.22; x < w * 0.8; x += 46) {
      this.bg.lineBetween(x, netY - 13, x + 22, netY + 13);
    }

    this.trails.clear();
    for (let i = 0; i < 16; i += 1) {
      const y = h * 0.2 + i * (h / 18);
      this.trails.lineStyle(1, i % 2 ? 0x66e6ff : 0xb9ff62, 0.35);
      this.trails.beginPath();
      this.trails.moveTo(0, y);
      for (let step = 1; step <= 24; step += 1) {
        const t = step / 24;
        const px = w * t;
        const wave = Math.sin(i + this.elapsed + t * Math.PI) * 34;
        const py = y + wave - 16 * t;
        this.trails.lineTo(px, py);
      }
      this.trails.strokePath();
    }
    if (this.pulse > 0) {
      this.bg.fillStyle(0xff6f91, this.pulse * 0.18);
      this.bg.fillRect(0, 0, w, h);
    }
  }

  updateBalls(dt) {
    const h = this.scale.height;
    const w = this.scale.width;
    this.targetLayer.clear();
    if (game.mode !== "playing" || !game.players.length) {
      if (this.rallyBall) {
        this.rallyBall.shadow.setVisible(false);
        this.rallyBall.glow.setVisible(false);
        this.rallyBall.body.setVisible(false);
        this.rallyBall.stripe.setVisible(false);
      }
      return;
    }
    if (!this.rallyBall?.active) this.resetRallyBall(0, true);
    const ball = this.rallyBall;
    ball.shadow.setVisible(true);
    ball.glow.setVisible(true);
    ball.body.setVisible(true);
    ball.stripe.setVisible(true);
    if (!ball.waiting) ball.travel += ball.direction * ball.speed * dt;
    ball.spin += dt * 8;

    const nearY = h * 0.78;
    const farY = h * 0.24;
    const t = Phaser.Math.Clamp(ball.travel, 0, 1);
    const sideMode = game.playMode === "people" && game.players.length > 1;
    const targetNear = !sideMode || ball.targetIndex === 0;
    const depth = targetNear ? t : 1 - t;
    const courtX = w * 0.14;
    const centerX = w * 0.5 + ball.xCurve * w * Math.sin(t * Math.PI);
    const y = Phaser.Math.Linear(farY, nearY, t);
    const scale = 0.55 + depth * 0.75;
    const bounce = Math.abs(Math.sin(t * Math.PI * 2.0)) * (78 - depth * 26);
    const x = Phaser.Math.Clamp(centerX, courtX + 70, w - courtX - 70);
    const drawY = y - bounce;
    ball.x = x;
    ball.y = y;
    ball.drawY = drawY;
    ball.targetY = targetNear ? nearY : farY;
    ball.hittable = Math.abs(y - ball.targetY) < 95 && bounce < 48;

    ball.shadow.setPosition(x, y + 18);
    ball.shadow.setScale(scale, 0.7 + depth * 0.4);
    ball.shadow.setAlpha(0.18 + depth * 0.28);
    ball.glow.setPosition(x, drawY);
    ball.glow.setRadius(24 * scale);
    ball.glow.setAlpha(0.16 + depth * 0.22);
    ball.body.setPosition(x, drawY);
    ball.body.setRadius(15 * scale);
    ball.stripe.clear();
    ball.stripe.setVisible(true);
    ball.stripe.lineStyle(Math.max(2, 3 * scale), 0x66e6ff, 0.9);
    ball.stripe.beginPath();
    ball.stripe.arc(x, drawY, 9 * scale, -1.2 + ball.spin, 1.2 + ball.spin, false);
    ball.stripe.strokePath();

    const targetColor = game.players[ball.targetIndex]?.color || "#66e6ff";
    this.targetLayer.lineStyle(3, Phaser.Display.Color.HexStringToColor(targetColor).color, ball.hittable ? 0.75 : 0.28);
    this.targetLayer.strokeEllipse(x, ball.targetY + 20, 122 * scale, 42 * scale);

    const missedNear = targetNear && t >= 1.04;
    const missedFar = !targetNear && t <= -0.04;
    if (missedNear || missedFar) this.missRally(ball);
  }

  missRally(ball) {
    if (!ball?.active) return;
    ball.active = false;
    game.streak = 0;
    if (game.playMode === "people") {
      const other = ball.targetIndex === 0 ? 1 : 0;
      game.sideScores[other] += 1;
    } else {
      game.aiScore += 1;
    }
    this.pulse = 0.8;
    this.burst(ball.x, ball.targetY, "#ff6f91", 8);
    tone(120, 0.12, "sawtooth", 0.04);
    updateHud();
    setTimeout(() => this.resetRallyBall(ball.targetIndex, true), 800);
  }

  updateParticles(dt) {
    this.particles = this.particles.filter((particle) => {
      particle.life -= dt;
      particle.dot.x += particle.vx * dt;
      particle.dot.y += particle.vy * dt;
      particle.vy += 360 * dt;
      particle.dot.setAlpha(Math.max(0, particle.life));
      if (particle.life <= 0) {
        particle.dot.destroy();
        return false;
      }
      return true;
    });
  }

  update(time, delta) {
    const dt = Math.min(0.033, delta / 1000);
    this.elapsed += dt;
    this.pulse = Math.max(0, this.pulse - dt * 2);
    this.drawArena();
    this.syncPlayers();

    for (const player of game.players) {
      player.energy = Math.max(0, (player.energy || 0) - dt * 1.8);
      player.swingFlash = Math.max(0, (player.swingFlash || 0) - dt * 3.6);
    }

    if (game.mode === "playing") {
      game.timeLeft = Math.max(0, game.timeLeft - dt);
      if (game.timeLeft <= 0) finishGame();
    }

    this.updateBalls(dt);
    this.updateParticles(dt);

    const waiting = game.mode === "lobby" && game.players.length === 0;
    this.prompt.setText(waiting ? "Waiting for a tennis controller" : "");
    this.promptSub.setText(waiting ? "Open the phone link and enter the code." : "");
    this.prompt.setPosition(this.scale.width * 0.5, this.scale.height * 0.48);
    this.promptSub.setPosition(this.scale.width * 0.5, this.scale.height * 0.53);
  }
}

function startPhaser() {
  phaserGame = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "gameRoot",
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: "#071426",
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    render: {
      antialias: true,
      pixelArt: false,
    },
    scene: MatchScene,
  });
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

function isPlaceholderName(name) {
  return normalizeName(name) === "" || normalizeName(name) === "player";
}

function removePlayer(playerOrId) {
  const id = typeof playerOrId === "string" ? playerOrId : playerOrId?.id;
  const index = game.players.findIndex((player) => player.id === id);
  if (index === -1 || game.mode === "playing") return;
  const [player] = game.players.splice(index, 1);
  game.connections = game.connections.filter((conn) => conn !== player.conn);
  try {
    player.conn?.send?.({ type: "kicked" });
  } catch {}
  if (sceneRef?.playerSprites?.has(player.id)) {
    sceneRef.playerSprites.get(player.id).group.destroy();
    sceneRef.playerSprites.delete(player.id);
  }
  updateLobby();
}

function mergeDuplicatePlayer(player, newName) {
  const normalized = normalizeName(newName || player.name);
  if (!normalized || isPlaceholderName(newName || player.name)) return player;
  const duplicate = game.players.find((item) => item !== player && normalizeName(item.name) === normalized);
  if (!duplicate) return player;

  duplicate.conn = player.conn || duplicate.conn;
  duplicate.connected = true;
  duplicate.lastMotion = Math.max(duplicate.lastMotion || 0, player.lastMotion || 0);
  duplicate.lastSwingPower = Math.max(duplicate.lastSwingPower || 0, player.lastSwingPower || 0);
  duplicate.lastSwingAt = Math.max(duplicate.lastSwingAt || 0, player.lastSwingAt || 0);
  removePlayer(player.id);
  return duplicate;
}

function createPlayer(id, conn, name = "Player") {
  const incomingName = String(name || "Player").slice(0, 14);
  const namedDuplicate = !isPlaceholderName(incomingName)
    ? game.players.find((player) => normalizeName(player.name) === normalizeName(incomingName))
    : null;
  if (namedDuplicate) {
    namedDuplicate.conn = conn;
    namedDuplicate.connected = true;
    return namedDuplicate;
  }

  const placeholder = !isPlaceholderName(incomingName)
    ? game.players.find((player) => isPlaceholderName(player.name) && !player.lastMotion && !player.lastSwingAt)
    : null;
  if (placeholder) {
    placeholder.id = id;
    placeholder.conn = conn;
    placeholder.name = incomingName;
    placeholder.connected = true;
    placeholder.joinedAt = Date.now();
    return placeholder;
  }

  const player = {
    id,
    conn,
    name: incomingName,
    color: colors[game.players.length % colors.length],
    connected: true,
    joinedAt: Date.now(),
    energy: 0,
    swingFlash: 0,
  };
  game.players.push(player);
  return player;
}

function updateLobby() {
  if (game.mode !== "playing") {
    const now = Date.now();
    for (const player of [...game.players]) {
      const stalePlaceholder = isPlaceholderName(player.name) && player.joinedAt && now - player.joinedAt > 4500 && !player.lastMotion && !player.lastSwingAt;
      if (stalePlaceholder) removePlayer(player.id);
    }
  }
  tv.players.innerHTML = "";
  game.players.forEach((player, index) => {
    const item = document.createElement("div");
    item.className = "player-pill";
    item.style.borderLeft = `5px solid ${player.color}`;
    const test = player.lastSwingPower ? `${player.lastSwingPower.toFixed(1)}` : `${(player.lastMotion || 0).toFixed(1)}`;
    item.innerHTML = `<span>${player.name}</span><small>P${index + 1} ${test}</small><button type="button" class="kick-button" aria-label="Remove ${player.name}">x</button>`;
    item.querySelector("button").addEventListener("click", () => removePlayer(player.id));
    tv.players.appendChild(item);
  });
  const needed = game.playMode === "people" ? 2 : 1;
  tv.start.disabled = game.players.length < needed || game.mode === "playing";
  tv.modeAi.classList.toggle("active", game.playMode === "ai");
  tv.modePeople.classList.toggle("active", game.playMode === "people");
  tv.status.textContent = game.players.length
    ? `${game.players.length} controller${game.players.length === 1 ? "" : "s"} ready. ${game.playMode === "people" ? "People mode needs 2." : "AI mode can start with 1."}`
    : `Open this on your phone: ${modeLink()}`;
  updateTestPanel();
}

function updateTestPanel(player = game.players[game.players.length - 1]) {
  if (!tv.testStatus || !tv.testMeter) return;
  if (!player) {
    tv.testStatus.textContent = "Connect a phone, then swing.";
    tv.testMeter.style.width = "0%";
    return;
  }
  const value = Math.max(player.lastSwingPower || 0, player.lastMotion || 0);
  const percent = Math.min(100, value * 82);
  tv.testMeter.style.width = `${percent}%`;
  if (player.lastSwingAt && Date.now() - player.lastSwingAt < 1800) {
    tv.testStatus.textContent = `${player.name}: swing received (${(player.lastSwingPower || 0).toFixed(1)})`;
  } else {
    tv.testStatus.textContent = `${player.name}: motion ${(player.lastMotion || 0).toFixed(1)} - swing to test`;
  }
}

function setPlayMode(mode) {
  game.playMode = mode;
  updateLobby();
}

function broadcast(data) {
  for (const conn of game.connections) {
    if (conn.open) conn.send(data);
  }
  publishRelayAll(data);
}

function publishRelayAll(data) {
  if (!relayClient?.connected || !relayCode) return;
  for (const player of game.players) {
    if (!player.id.startsWith("relay-")) continue;
    relayClient.publish(`${relayBase(relayCode)}/ctrl/${player.id}`, JSON.stringify(data), { qos: 0 });
  }
}

function publishRelayTo(player, data) {
  if (!relayClient?.connected || !relayCode || !player.id.startsWith("relay-")) return;
  relayClient.publish(`${relayBase(relayCode)}/ctrl/${player.id}`, JSON.stringify(data), { qos: 0 });
}

function makeLocalConn(channel, controllerId) {
  return {
    peer: controllerId,
    open: true,
    send(data) {
      channel.postMessage({ target: "controller", controllerId, data });
    },
    on() {},
  };
}

function startLocalHost(code) {
  if (!("BroadcastChannel" in window)) return;
  localHostChannel = new BroadcastChannel(`motion-match-${code}`);
  localHostChannel.onmessage = (event) => {
    const message = event.data || {};
    if (message.target !== "host" || !message.controllerId) return;
    let player = game.players.find((item) => item.id === message.controllerId);
    if (!player && message.data?.type === "hello") {
      const conn = makeLocalConn(localHostChannel, message.controllerId);
      player = createPlayer(message.controllerId, conn, message.data.name || "Player");
      if (!game.connections.includes(conn)) game.connections.push(conn);
      conn.send({ type: "welcome", index: game.players.indexOf(player), color: player.color, mode: game.mode });
      updateLobby();
      return;
    }
    if (player) handleControllerMessage(player, message.data);
  };
}

function startRelayHost(code) {
  relayCode = code;
  const clientId = `phone-tennis-tv-${code}-${Math.random().toString(36).slice(2)}`;
  relayClient = new TinyMqtt(clientId);
  relayClient.onconnect = () => {
    relayClient.subscribe(`${relayBase(code)}/host`, (payload) => {
      const message = safeJson(payload);
      if (!message?.controllerId || !message.data) return;
      const id = `relay-${message.controllerId}`;
      let player = game.players.find((item) => item.id === id);
      if (!player && message.data.type === "hello") {
        const conn = {
          peer: id,
          open: true,
          send(data) {
            publishRelayTo(player, data);
          },
          on() {},
        };
        player = createPlayer(id, conn, message.data.name || "Player");
        if (!game.connections.includes(conn)) game.connections.push(conn);
        publishRelayTo(player, { type: "welcome", index: game.players.indexOf(player), color: player.color, mode: game.mode, relay: true });
        updateLobby();
        return;
      }
      if (player) handleControllerMessage(player, message.data);
    });
    updateLobby();
  };
}

function addConnection(conn) {
  if (game.connections.length >= 4) {
    conn.on("open", () => conn.send({ type: "full" }));
    return;
  }
  const player = createPlayer(conn.peer, conn, "Player");
  if (!game.connections.includes(conn)) game.connections.push(conn);

  conn.on("data", (data) => handleControllerMessage(player, data));
  conn.on("close", () => {
    player.connected = false;
    updateLobby();
  });
  conn.on("error", () => {
    player.connected = false;
    updateLobby();
  });
  conn.on("open", () => {
    conn.send({ type: "welcome", index: game.players.indexOf(player), color: player.color, mode: game.mode });
    updateLobby();
  });
  updateLobby();
}

function handleControllerMessage(player, data) {
  if (!data || typeof data !== "object") return;
  if (data.type === "hello") {
    player.name = String(data.name || "Player").slice(0, 14);
    player = mergeDuplicatePlayer(player, player.name);
    updateLobby();
    player.conn.send({ type: "welcome", index: game.players.indexOf(player), color: player.color, mode: game.mode });
    publishRelayTo(player, { type: "welcome", index: game.players.indexOf(player), color: player.color, mode: game.mode, relay: true });
  }
  if (data.type === "motion") {
    player.energy = Math.min(1, Math.max(player.energy || 0, data.energy || 0));
    player.lastMotion = data.energy || 0;
    updateTestPanel(player);
  }
  if (data.type === "swing") {
    player.lastSwingPower = data.power || 1;
    player.lastSwingAt = Date.now();
    player.swingFlash = 1;
    updateTestPanel(player);
    if (game.mode === "playing") {
      registerSwing(player, data.power || 1);
    } else {
      tone(420, 0.06, "triangle", 0.045);
      if (player.conn.open) player.conn.send({ type: "test", power: data.power || 1 });
    }
  }
}

function registerSwing(player, power) {
  if (game.mode !== "playing" || !sceneRef) return;
  ensureAudio();
  const playerIndex = game.players.indexOf(player);
  player.energy = Math.min(1, Math.max(player.energy, power));
  player.swingFlash = 1;
  const ball = sceneRef.rallyBall;
  if (ball?.active && ball.targetIndex === playerIndex && ball.hittable) {
    const timing = 1 - Math.min(1, Math.abs(ball.y - ball.targetY) / 95);
    const points = Math.round(10 + timing * 25 + Math.min(power, 1.5) * 8);
    if (game.playMode === "people") {
      game.sideScores[playerIndex] += 1;
      game.score = game.sideScores[0] + game.sideScores[1];
    } else {
      game.score += points + game.streak;
    }
    game.streak += 1;
    sceneRef.pulse = 0.4;
    sceneRef.burst(ball.x, ball.drawY, player.color, 18);
    tone(360 + timing * 320, 0.08, "triangle", 0.08);
    if (player.conn.open) player.conn.send({ type: "hit", quality: timing, points });
    const nextTarget = game.playMode === "people" && game.players.length > 1 ? (playerIndex === 0 ? 1 : 0) : 0;
    ball.direction = playerIndex === 0 ? -1 : 1;
    ball.targetIndex = nextTarget;
    ball.speed = 0.32 + Math.min(0.16, (game.score + game.streak) / 1800);
    ball.xCurve = (Math.random() - 0.5) * 0.22;
    ball.hittable = false;
    if (game.playMode === "ai") {
      setTimeout(() => {
        if (game.mode !== "playing" || !sceneRef?.rallyBall?.active) return;
        sceneRef.rallyBall.direction = 1;
        sceneRef.rallyBall.targetIndex = 0;
        sceneRef.rallyBall.speed = 0.31 + Math.min(0.16, game.score / 1800);
        sceneRef.rallyBall.xCurve = (Math.random() - 0.5) * 0.2;
        sceneRef.burst(sceneRef.rallyBall.x, sceneRef.rallyBall.drawY, "#ffc857", 10);
        tone(300, 0.05, "triangle", 0.04);
      }, 1150);
    }
  } else {
    game.streak = 0;
    tone(170, 0.07, "square", 0.035);
    if (player.conn.open) player.conn.send({ type: "miss" });
  }
  updateHud();
}

function updateHud() {
  tv.score.textContent = game.playMode === "ai" ? `${game.score}-${game.aiScore}` : game.playMode === "people" ? `${game.sideScores[0]}-${game.sideScores[1]}` : String(game.score);
  tv.streak.textContent = String(game.streak);
  tv.timer.textContent = String(Math.ceil(game.timeLeft));
}

function startMatch() {
  ensureAudio();
  game.mode = "playing";
  if (sceneRef) {
    sceneRef.balls = [];
    if (sceneRef.rallyBall) sceneRef.rallyBall.active = false;
  }
  game.score = 0;
  game.aiScore = 0;
  game.sideScores = [0, 0];
  game.streak = 0;
  game.timeLeft = 60;
  game.spawnTimer = 0.8;
  sceneRef?.resetRallyBall(0, true);
  tv.lobby.hidden = true;
  tv.result.hidden = true;
  tv.hud.hidden = false;
  updateHud();
  broadcast({ type: "start" });
}

function finishGame() {
  if (game.mode !== "playing") return;
  game.mode = "result";
  tv.hud.hidden = true;
  tv.result.hidden = false;
  tv.finalScore.textContent = game.playMode === "ai" ? `${game.score}-${game.aiScore}` : game.playMode === "people" ? `${game.sideScores[0]}-${game.sideScores[1]}` : String(game.score);
  tv.resultLine.textContent = game.score > 900 ? "Grand Slam energy." : game.score > 450 ? "That was a clean rally." : "Warm up the serve return and run it back.";
  broadcast({ type: "finish", score: game.score });
}

async function startHost() {
  startPhaser();
  hostCode = makeCode();
  tv.code.textContent = hostCode;
  tv.status.textContent = "Opening lobby...";
  startLocalHost(hostCode);
  startRelayHost(hostCode);
  peer = new Peer(`motion-match-${hostCode}`, {
    host: "0.peerjs.com",
    port: 443,
    path: "/",
    secure: true,
  });
  peer.on("open", () => {
    tv.status.textContent = `Open this on your phone: ${modeLink()}`;
    updateLobby();
  });
  peer.on("connection", addConnection);
  peer.on("error", (err) => {
    tv.status.textContent = `Public pairing is slow, but same-site controllers can still join: ${modeLink()}`;
  });
  setTimeout(() => {
    if (!peer.open && game.mode === "lobby") {
      tv.status.textContent = `Public pairing is still opening. Same-site test link: ${modeLink()}`;
    }
  }, 2500);
  tv.copy.addEventListener("click", async () => {
    await navigator.clipboard?.writeText(modeLink());
    tv.copy.textContent = "Copied";
    setTimeout(() => (tv.copy.textContent = "Copy phone link"), 1000);
  });
  tv.start.addEventListener("click", startMatch);
  tv.modeAi.addEventListener("click", () => setPlayMode("ai"));
  tv.modePeople.addEventListener("click", () => setPlayMode("people"));
  tv.playAgain.addEventListener("click", () => {
    tv.lobby.hidden = false;
    tv.result.hidden = true;
    game.mode = "lobby";
    updateLobby();
    broadcast({ type: "lobby" });
  });
  setInterval(updateHud, 200);
}

function setPhoneStatus(text) {
  phone.status.textContent = text;
  phone.hint.textContent = text;
}

function send(data) {
  if (myConn?.open) myConn.send(data);
  if (localControllerChannel && localControllerId) {
    localControllerChannel.postMessage({ target: "host", controllerId: localControllerId, data });
  }
  if (relayClient?.connected && relayControllerId && relayCode) {
    relayClient.publish(`${relayBase(relayCode)}/host`, JSON.stringify({ controllerId: relayControllerId, data }), { qos: 0 });
  }
}

function showControllerConnected(name, text) {
  relayConfirmed = true;
  phone.connect.hidden = true;
  phone.panel.hidden = false;
  phone.controllerName.textContent = name;
  setPhoneStatus(text);
  buzz([20, 30, 20]);
}

function startLocalController(code, name) {
  if (!("BroadcastChannel" in window) || localControllerChannel) return;
  localControllerId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localControllerChannel = new BroadcastChannel(`motion-match-${code}`);
  localControllerChannel.onmessage = (event) => {
    const message = event.data || {};
    if (message.target !== "controller" || message.controllerId !== localControllerId) return;
    handleHostMessage(message.data);
  };
  localControllerChannel.postMessage({ target: "host", controllerId: localControllerId, data: { type: "hello", name } });
}

function startRelayController(code, name) {
  if (relayClient) return;
  relayCode = code;
  relayControllerId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  relayClient = new TinyMqtt(`phone-tennis-phone-${relayControllerId}`);
  relayClient.onconnect = () => {
    phone.status.textContent = "Relay connected. Waiting for PC...";
    relayClient.subscribe(`${relayBase(code)}/ctrl/relay-${relayControllerId}`, (payload) => {
      handleHostMessage(safeJson(payload));
    });
    send({ type: "hello", name });
  };
}

function connectPhone() {
  ensureAudio();
  const code = phone.code.value.trim().toUpperCase();
  const name = (phone.name.value.trim() || randomName()).slice(0, 14);
  if (code.length < 4) {
    phone.status.textContent = "Enter the four character game code.";
    return;
  }
  phone.join.disabled = true;
  relayConfirmed = false;
  phone.status.textContent = "Connecting to PC...";
  const localTimer = setTimeout(() => {
    if (!myConn?.open) startLocalController(code, name);
  }, 1000);
  const relayTimer = setTimeout(() => {
    if (!relayConfirmed) startRelayController(code, name);
  }, 1200);
  peer = new Peer(undefined, {
    host: "0.peerjs.com",
    port: 443,
    path: "/",
    secure: true,
  });
  peer.on("open", () => {
    myConn = peer.connect(`motion-match-${code}`, { reliable: false });
    myConn.on("open", () => {
      clearTimeout(localTimer);
      clearTimeout(relayTimer);
      send({ type: "hello", name });
    });
    myConn.on("data", handleHostMessage);
    myConn.on("close", () => {
      setPhoneStatus("Disconnected. Refresh and join again.");
    });
  });
  peer.on("error", (err) => {
    startRelayController(code, name);
  });
}

function handleHostMessage(data) {
  if (!data || typeof data !== "object") return;
  if (data.type === "full") setPhoneStatus("That game is full.");
  if (data.type === "kicked") {
    setPhoneStatus("Removed from lobby. Reconnect if you want to play.");
    phone.panel.hidden = true;
    phone.connect.hidden = false;
    phone.join.disabled = false;
  }
  if (data.type === "welcome") {
    document.documentElement.style.setProperty("--cyan", data.color || "#66e6ff");
    const name = phone.name.value.trim() || phone.controllerName.textContent || "Player";
    showControllerConnected(name, data.relay ? "Connected through relay. Enable motion, then test a swing." : "Connected. Enable motion, then test a swing.");
  }
  if (data.type === "start") {
    setPhoneStatus("Match started. Swing when the ball bounces near you.");
    buzz([40, 40, 40]);
  }
  if (data.type === "test") {
    setPhoneStatus(`Test swing received (${Number(data.power || 0).toFixed(1)}).`);
    buzz(18);
  }
  if (data.type === "hit") {
    setPhoneStatus(`Hit! +${data.points}`);
    buzz(25);
    tone(520 + data.quality * 180, 0.06, "triangle", 0.05);
  }
  if (data.type === "miss") {
    setPhoneStatus("Miss. Wait for the next ball.");
    buzz([60, 30, 60]);
  }
  if (data.type === "finish") {
    setPhoneStatus(`Final score: ${data.score}`);
    buzz([40, 80, 40, 80, 80]);
  }
  if (data.type === "lobby") {
    setPhoneStatus("Back in lobby. Ready for the next match.");
  }
}

let lastSwing = 0;
let lastMotionSend = 0;
let smoothEnergy = 0;

function motionEnergy(event) {
  const a = event.accelerationIncludingGravity || event.acceleration || {};
  const r = event.rotationRate || {};
  const accel = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
  const rot = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0) / 90;
  return Math.max(0, Math.min(2, (accel - 8.5) / 8 + rot * 0.52));
}

function onMotion(event) {
  const energy = motionEnergy(event);
  smoothEnergy = smoothEnergy * 0.75 + energy * 0.25;
  const meter = Math.min(100, smoothEnergy * 70);
  phone.meter.style.width = `${meter}%`;
  phone.readout.textContent = smoothEnergy.toFixed(1);
  const now = performance.now();
  if (now - lastMotionSend > 90) {
    send({ type: "motion", energy: Math.min(1, smoothEnergy) });
    lastMotionSend = now;
  }
  if (smoothEnergy > 0.42 && now - lastSwing > 420) {
    lastSwing = now;
    send({ type: "swing", power: Math.min(1.5, smoothEnergy) });
  }
}

async function enableMotion() {
  ensureAudio();
  try {
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
      const result = await DeviceMotionEvent.requestPermission();
      if (result !== "granted") {
        setPhoneStatus("Motion permission was not granted. The big Swing button still works.");
        return;
      }
    }
    window.addEventListener("devicemotion", onMotion);
    phone.permission.textContent = "Motion enabled";
    setPhoneStatus("Motion is live. Swing when the ball bounces near you.");
    buzz(35);
  } catch {
    setPhoneStatus("Motion could not start. The big Swing button still works.");
  }
}

function manualSwing() {
  ensureAudio();
  lastSwing = performance.now();
  smoothEnergy = 1.2;
  phone.meter.style.width = "86%";
  phone.readout.textContent = "1.2";
  send({ type: "swing", power: 1.15 });
  buzz(20);
  setTimeout(() => {
    phone.meter.style.width = "8%";
    phone.readout.textContent = "0.0";
  }, 260);
}

function startPhone() {
  phone.code.value = (params.get("code") || "").toUpperCase();
  phone.name.value = localStorage.getItem("motion-match-name") || randomName();
  phone.join.addEventListener("click", () => {
    localStorage.setItem("motion-match-name", phone.name.value.trim() || randomName());
    connectPhone();
  });
  phone.permission.addEventListener("click", enableMotion);
  phone.swing.addEventListener("click", manualSwing);
  phone.code.addEventListener("input", () => {
    phone.code.value = phone.code.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
}

setViews();
if (isController) {
  startPhone();
} else {
  startHost();
}
