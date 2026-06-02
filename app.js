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

const game = {
  mode: "lobby",
  players: [],
  connections: [],
  score: 0,
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
    const laneWidth = this.scale.width / total;
    return {
      x: laneWidth * index + laneWidth / 2,
      y: this.scale.height * 0.82,
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
  }

  spawnBall() {
    if (!game.players.length) return;
    const playerIndex = Math.floor(Math.random() * game.players.length);
    const lane = this.lane(playerIndex);
    const color = game.players[playerIndex].color;
    const sprite = this.add.group();
    const glow = this.add.circle(lane.x, -40, 30, Phaser.Display.Color.HexStringToColor(color).color, 0.22);
    const body = this.add.circle(lane.x, -40, 20 + Math.random() * 7, 0xf9fbff, 1);
    const stripe = this.add.graphics();
    sprite.add(glow);
    sprite.add(body);
    sprite.add(stripe);
    this.balls.push({
      playerIndex,
      sprite,
      glow,
      body,
      stripe,
      xDrift: (Math.random() - 0.5) * 42,
      y: -40,
      speed: 165 + Math.min(150, game.score * 1.8),
      spin: Math.random() * Math.PI * 2,
      hit: false,
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
    this.bg.fillStyle(0x1d8f6b, 0.48);
    this.bg.fillRect(courtX, courtY, courtW, courtH);
    this.bg.lineStyle(5, 0xf9fbff, 0.5);
    this.bg.strokeRect(courtX, courtY, courtW, courtH);
    this.bg.lineStyle(3, 0xf9fbff, 0.38);
    this.bg.strokeRect(courtX + courtW * 0.12, courtY + courtH * 0.08, courtW * 0.76, courtH * 0.84);
    this.bg.lineBetween(w * 0.5, courtY + courtH * 0.08, w * 0.5, courtY + courtH * 0.92);
    this.bg.lineBetween(courtX + courtW * 0.12, netY, courtX + courtW * 0.88, netY);
    this.bg.lineStyle(9, 0xffffff, 0.7);
    this.bg.lineBetween(courtX, netY, courtX + courtW, netY);
    this.bg.lineStyle(2, 0x06121e, 0.3);
    for (let x = courtX + 24; x < courtX + courtW; x += 46) {
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
    this.targetLayer.clear();
    for (const ball of this.balls) {
      ball.y += ball.speed * dt;
      ball.spin += dt * 7;
      const lane = this.lane(ball.playerIndex);
      const x = lane.x + Math.sin(ball.y / 90 + ball.spin) * 24 + ball.xDrift * (ball.y / h);
      ball.glow.setPosition(x, ball.y);
      ball.body.setPosition(x, ball.y);
      ball.body.setRotation(ball.spin);
      ball.stripe.clear();
      ball.stripe.lineStyle(4, Phaser.Display.Color.HexStringToColor(game.players[ball.playerIndex]?.color || "#66e6ff").color, 1);
      ball.stripe.beginPath();
      ball.stripe.arc(x, ball.y, ball.body.radius * 0.62, -1.2 + ball.spin, 1.2 + ball.spin, false);
      ball.stripe.strokePath();
      ball.x = x;
      ball.targetY = lane.y - 56;

      if (game.mode === "playing") {
        const target = 1 - Math.min(1, Math.abs(ball.y - ball.targetY) / 160);
        this.targetLayer.lineStyle(3, Phaser.Display.Color.HexStringToColor(game.players[ball.playerIndex]?.color || "#ffffff").color, 0.18 + target * 0.38);
        this.targetLayer.strokeCircle(x, ball.targetY, 70 + Math.sin(this.elapsed * 8) * 5);
      }

      if (!ball.hit && game.mode === "playing" && ball.y > lane.y + 58) {
        ball.hit = true;
        game.streak = 0;
        this.pulse = 0.8;
        this.burst(x, lane.y, "#ff6f91", 8);
        tone(120, 0.12, "sawtooth", 0.04);
        updateHud();
      }
    }
    this.balls = this.balls.filter((ball) => {
      const keep = ball.y < h + 80 && !ball.remove;
      if (!keep) ball.sprite.destroy(true);
      return keep;
    });
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
      game.spawnTimer -= dt;
      if (game.spawnTimer <= 0) {
        this.spawnBall();
        game.spawnTimer = Math.max(0.62, 1.35 - game.score / 220);
      }
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

function updateLobby() {
  tv.players.innerHTML = "";
  game.players.forEach((player, index) => {
    const item = document.createElement("div");
    item.className = "player-pill";
    item.style.borderLeft = `5px solid ${player.color}`;
    item.innerHTML = `<span>${player.name}</span><small>P${index + 1}</small>`;
    tv.players.appendChild(item);
  });
  tv.start.disabled = game.players.length === 0 || game.mode === "playing";
  tv.status.textContent = game.players.length
    ? `${game.players.length} controller${game.players.length === 1 ? "" : "s"} ready.`
    : `Open this on your phone: ${modeLink()}`;
}

function broadcast(data) {
  for (const conn of game.connections) {
    if (conn.open) conn.send(data);
  }
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
      player = {
        id: message.controllerId,
        conn,
        name: String(message.data.name || "Player").slice(0, 14),
        color: colors[game.players.length % colors.length],
        connected: true,
        energy: 0,
        swingFlash: 0,
      };
      game.connections.push(conn);
      game.players.push(player);
      conn.send({ type: "welcome", index: game.players.indexOf(player), color: player.color, mode: game.mode });
      updateLobby();
      return;
    }
    if (player) handleControllerMessage(player, message.data);
  };
}

function addConnection(conn) {
  if (game.connections.length >= 4) {
    conn.on("open", () => conn.send({ type: "full" }));
    return;
  }
  game.connections.push(conn);
  const player = {
    id: conn.peer,
    conn,
    name: "Player",
    color: colors[game.players.length % colors.length],
    connected: true,
    energy: 0,
    swingFlash: 0,
  };
  game.players.push(player);

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
    updateLobby();
    player.conn.send({ type: "welcome", index: game.players.indexOf(player), color: player.color, mode: game.mode });
  }
  if (data.type === "motion") {
    player.energy = Math.min(1, Math.max(player.energy || 0, data.energy || 0));
  }
  if (data.type === "swing") {
    registerSwing(player, data.power || 1);
  }
}

function registerSwing(player, power) {
  if (game.mode !== "playing" || !sceneRef) return;
  ensureAudio();
  const playerIndex = game.players.indexOf(player);
  player.energy = Math.min(1, Math.max(player.energy, power));
  player.swingFlash = 1;
  const lane = sceneRef.lane(playerIndex);
  let best = null;
  let bestDistance = Infinity;
  for (const ball of sceneRef.balls) {
    if (ball.playerIndex !== playerIndex || ball.hit) continue;
    const distance = Math.abs(ball.y - (lane.y - 56));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = ball;
    }
  }
  if (best && bestDistance < 140) {
    best.hit = true;
    best.remove = true;
    const timing = 1 - bestDistance / 140;
    const points = Math.round(10 + timing * 25 + Math.min(power, 1.5) * 8);
    game.score += points + game.streak;
    game.streak += 1;
    sceneRef.pulse = 0.4;
    sceneRef.burst(best.x, best.y, player.color, 18);
    tone(360 + timing * 320, 0.08, "triangle", 0.08);
    if (player.conn.open) player.conn.send({ type: "hit", quality: timing, points });
  } else {
    game.streak = 0;
    tone(170, 0.07, "square", 0.035);
    if (player.conn.open) player.conn.send({ type: "miss" });
  }
  updateHud();
}

function updateHud() {
  tv.score.textContent = String(game.score);
  tv.streak.textContent = String(game.streak);
  tv.timer.textContent = String(Math.ceil(game.timeLeft));
}

function startMatch() {
  ensureAudio();
  game.mode = "playing";
  if (sceneRef) {
    for (const ball of sceneRef.balls) ball.sprite.destroy(true);
    sceneRef.balls = [];
  }
  game.score = 0;
  game.streak = 0;
  game.timeLeft = 60;
  game.spawnTimer = 0.8;
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
  tv.finalScore.textContent = String(game.score);
  tv.resultLine.textContent = game.score > 900 ? "Grand Slam energy." : game.score > 450 ? "That was a clean rally." : "Warm up the serve return and run it back.";
  broadcast({ type: "finish", score: game.score });
}

async function startHost() {
  startPhaser();
  hostCode = makeCode();
  tv.code.textContent = hostCode;
  tv.status.textContent = "Opening lobby...";
  startLocalHost(hostCode);
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
  phone.connect.hidden = true;
  phone.panel.hidden = false;
  phone.controllerName.textContent = name;
  setPhoneStatus("Connected locally. Enable motion, then swing when the ball reaches your circle.");
  buzz([20, 30, 20]);
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
  phone.status.textContent = "Connecting...";
  const localTimer = setTimeout(() => {
    if (!myConn?.open) startLocalController(code, name);
  }, 1400);
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
      send({ type: "hello", name });
      phone.connect.hidden = true;
      phone.panel.hidden = false;
      phone.controllerName.textContent = name;
      setPhoneStatus("Connected. Enable motion, then swing when the ball reaches your circle.");
      buzz([20, 30, 20]);
    });
    myConn.on("data", handleHostMessage);
    myConn.on("close", () => {
      setPhoneStatus("Disconnected. Refresh and join again.");
    });
  });
  peer.on("error", (err) => {
    startLocalController(code, name);
  });
}

function handleHostMessage(data) {
  if (!data || typeof data !== "object") return;
  if (data.type === "full") setPhoneStatus("That game is full.");
  if (data.type === "welcome") {
    document.documentElement.style.setProperty("--cyan", data.color || "#66e6ff");
  }
  if (data.type === "start") {
    setPhoneStatus("Match started. Swing when the ball drops into your return circle.");
    buzz([40, 40, 40]);
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
    setPhoneStatus("Motion is live. Swing when the ball drops into your return circle.");
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
