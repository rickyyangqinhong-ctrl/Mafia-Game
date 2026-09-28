const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname));

const rooms = {};

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 10;
const MAX_CHAT_LEN = 240;
const MAX_NAME_LEN = 16;
const CHAT_COOLDOWN_MS = 2000;
const NIGHT_SECONDS = 45;
const DAY_SECONDS = 90;
const EVENT_CHANCE = 0.5; // chance of a morning event each day

const ABDUCT = "Abduct (kill)";
const CONVERT = "Convert (once per game, whole Alien team)";

// ==============================
// ROLES
// ==============================
const ROLES = {
    Godfather: { faction: "Mafia", label: "🕴️ Godfather", description: "Choose a kill target each night. Detectives see you as innocent." },
    Consigliere: { faction: "Mafia", label: "🕵️ Consigliere", description: "Each night, learn a player's exact role." },
    Mafia: { faction: "Mafia", label: "🔪 Mafia", description: "Help the Mafia. You take over the kill if the Godfather dies." },
    Villager: { faction: "Innocent", label: "👤 Villager", description: "No power. Use your voice and your vote." },
    Doctor: { faction: "Innocent", label: "💉 Doctor", description: "Each night, protect one player from being killed." },
    Detective: { faction: "Innocent", label: "🔎 Detective", description: "Each night, check if a player is suspicious." },
    Bodyguard: { faction: "Innocent", label: "🛡️ Bodyguard", description: "Guard a player. If they're attacked, you die instead." },
    Jester: { faction: "Neutral", label: "🃏 Jester", description: "You win alone if the town votes you out." },
    SerialKiller: { faction: "Neutral", label: "🔪 Serial Killer", description: "Kill one player each night. Win by being the last one alive." },
    Survivor: { faction: "Neutral", label: "🌿 Survivor", description: "No team. Just stay alive." },
    Alien: { faction: "Alien", label: "👽 Alien", description: "Each night, Abduct (kill) someone. Once per game, your whole team can Convert a player into an Alien instead." }
};

// ==============================
// HELPERS
// ==============================
function makeCode() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }
function alive(room) { return room.players.filter(function(p) { return p.alive; }); }
function faction(p) { return ROLES[p.role].faction; }
function send(room, message) { io.to(room.code).emit("message", message); }
function mafiaRoom(room) { return room.code + "-mafia"; }
function shuffle(list) {
    const c = list.slice();
    for (let i = c.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = c[i]; c[i] = c[j]; c[j] = t;
    }
    return c;
}
function publicPlayers(room) {
    return room.players.map(function(p) { return { name: p.name, alive: p.alive }; });
}
function emitPlayers(room) { io.to(room.code).emit("players", publicPlayers(room)); }
function findAliveByName(room, name) {
    return room.players.find(function(p) { return p.alive && p.name === name; });
}
function getMafiaActor(room) {
    const l = alive(room).filter(function(p) { return p.role === "Godfather" || p.role === "Mafia"; });
    return l.find(function(p) { return p.role === "Godfather"; }) || l[0] || null;
}

function clearTimer(room) {
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    io.to(room.code).emit("timer", 0);
}
function setTimer(room, seconds, fn) {
    clearTimer(room);
    const id = room.phaseId;
    room.timer = setTimeout(function() {
        room.timer = null;
        if (rooms[room.code] === room && room.phaseId === id) fn();
    }, seconds * 1000);
    io.to(room.code).emit("timer", seconds);
}

function killPlayer(room, p) {
    p.alive = false;
    io.to(p.id).emit("eliminated");
}

// ==============================
// ROLE ASSIGNMENT
// ==============================
function getRoleList(count) {
    const n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, count));
    const mafia = n >= 9 ? 3 : n >= 6 ? 2 : 1;
    const alien = n >= 7 ? 1 : 0;
    const neutral = n >= 9 ? 2 : n >= 5 ? 1 : 0;

    const roles = [];
    ["Godfather", "Consigliere", "Mafia"].slice(0, mafia).forEach(function(r) { roles.push(r); });
    for (let i = 0; i < alien; i++) roles.push("Alien");
    ["Jester", "SerialKiller", "Survivor"].slice(0, neutral).forEach(function(r) { roles.push(r); });

    const special = ["Doctor", "Detective", "Bodyguard"];
    let idx = 0;
    while (roles.length < n && idx < special.length) roles.push(special[idx++]);
    while (roles.length < n) roles.push("Villager");
    return roles;
}

function assignRoles(room) {
    const list = shuffle(getRoleList(room.players.length));
    room.players.forEach(function(p, i) { p.role = list[i]; });
}

function sendRole(p) {
    io.to(p.id).emit("role", { label: ROLES[p.role].label, faction: faction(p), description: ROLES[p.role].description });
}

// ==============================
// GAME START / END
// ==============================
function startGame(room) {
    room.started = true;
    room.day = 1;
    room.votes = {};
    room.convertUsed = false;
    room.attackCount = 0;
    room.dayFlags = {};
    room.players.forEach(function(p) { p.alive = true; p.role = null; });
    assignRoles(room);

    room.players.forEach(function(p) {
        const s = io.sockets.sockets.get(p.id);
        if (s) { s.leave(mafiaRoom(room)); if (faction(p) === "Mafia") s.join(mafiaRoom(room)); }
        sendRole(p);
        io.to(p.id).emit("gameReset");
    });

    emitPlayers(room);
    io.to(room.code).emit("gameStarted");
    send(room, "🔪 The game has started with " + room.players.length + " players!");
    startNight(room);
}

function endGame(room, winner, solo) {
    clearTimer(room);
    room.phaseId++;
    room.started = false;
    room.phase = "ended";

    const text = { Mafia: "🔪 THE MAFIA WINS!", Town: "👤 THE TOWN WINS!", Alien: "👽 THE ALIENS WIN!",
        SerialKiller: "🔪 " + (solo ? solo.name : "") + " THE SERIAL KILLER WINS!",
        Jester: "🃏 " + (solo ? solo.name : "") + " THE JESTER WINS!", Nobody: "💀 Everyone is dead. Nobody wins." }[winner] || "Game over.";
    send(room, text);

    io.to(room.code).emit("gameEnded", {
        winner: winner,
        soloWinner: solo ? solo.name : null,
        players: room.players.map(function(p) {
            return { name: p.name, label: p.role ? ROLES[p.role].label : "?", alive: p.alive };
        })
    });
}

function checkWin(room) {
    const living = alive(room);
    if (living.length === 0) { endGame(room, "Nobody"); return true; }

    const mafia = living.filter(function(p) { return faction(p) === "Mafia"; }).length;
    const aliens = living.filter(function(p) { return faction(p) === "Alien"; }).length;
    const sk = living.find(function(p) { return p.role === "SerialKiller"; });

    if (sk && living.length === 1) { endGame(room, "SerialKiller", sk); return true; }
    if (!sk && mafia === 0 && aliens === 0) { endGame(room, "Town"); return true; }
    if (!sk && aliens === 0 && mafia > 0 && mafia >= living.length - mafia) { endGame(room, "Mafia"); return true; }
    if (!sk && mafia === 0 && aliens > 0 && aliens >= living.length - aliens) { endGame(room, "Alien"); return true; }
    return false;
}

// ==============================
// NIGHT
// ==============================
function startNight(room) {
    room.phase = "night";
    room.phaseId++;
    room.night = { attacks: [], converts: [] };
    room.pendingActions = new Set();
    room.dayFlags = {};
    io.to(room.code).emit("phase", { phase: "night", chatOpen: false });
    send(room, "🌙 NIGHT " + room.day + " — the town sleeps.");

    const living = alive(room);
    const acting = new Set();

    function prompt(p, type, title, names) {
        if (!names.length) return;
        room.pendingActions.add(p.id);
        acting.add(p.id);
        io.to(p.id).emit("nightAction", { type: type, title: title, players: names });
    }
    function others(p) { return living.filter(function(x) { return x.id !== p.id; }).map(function(x) { return x.name; }); }

    const actor = getMafiaActor(room);
    if (actor) prompt(actor, "mafiaKill", "🌙 Choose someone to eliminate:",
        living.filter(function(x) { return faction(x) !== "Mafia"; }).map(function(x) { return x.name; }));

    living.forEach(function(p) {
        if (p.role === "SerialKiller") prompt(p, "skKill", "🔪 Choose someone to eliminate:", others(p));
        if (p.role === "Doctor") prompt(p, "heal", "💉 Choose someone to protect:", living.map(function(x) { return x.name; }));
        if (p.role === "Detective") prompt(p, "investigate", "🔎 Choose someone to investigate:", others(p));
        if (p.role === "Consigliere") prompt(p, "investigateRole", "🕵️ Choose someone to investigate:", others(p));
        if (p.role === "Bodyguard") prompt(p, "guard", "🛡️ Choose someone to guard:", others(p));
        if (p.role === "Alien") sendAlienPrompt(room, p);
    });

    living.forEach(function(p) {
        if (!acting.has(p.id)) io.to(p.id).emit("waiting", "🌙 Night falls... others are taking action.");
    });

    if (room.pendingActions.size === 0) { resolveNight(room); return; }
    setTimer(room, NIGHT_SECONDS, function() { if (room.phase === "night") resolveNight(room); });
}

function alienTargets(room, p) {
    return alive(room).filter(function(x) { return faction(x) !== "Alien"; }).map(function(x) { return x.name; });
}

function sendAlienPrompt(room, p) {
    const targets = alienTargets(room, p);
    if (!targets.length) return;
    room.pendingActions.add(p.id);
    if (room.convertUsed) {
        io.to(p.id).emit("nightAction", { type: "alienAbduct", title: "👽 Choose someone to abduct:", players: targets });
    } else {
        io.to(p.id).emit("nightAction", { type: "alienMode", title: "👽 Abduct or Convert?", players: [ABDUCT, CONVERT] });
    }
}

function resolveNight(room) {
    if (room.phase !== "night") return;
    room.phase = "resolving";
    clearTimer(room);

    const n = room.night;
    const heal = n.healTarget || null;
    const guard = n.guardTarget || null;

    if (n.mafiaTarget) n.attacks.push(n.mafiaTarget);
    if (n.skTarget) n.attacks.push(n.skTarget);
    room.attackCount = n.attacks.length;

    const lines = [];
    n.attacks.forEach(function(name) {
        const t = findAliveByName(room, name);
        if (!t) return;
        if (heal === t.name) { lines.push("💉 Someone was attacked in the night, but the Doctor saved them!"); return; }
        const bg = guard === t.name ? alive(room).find(function(p) { return p.role === "Bodyguard" && p.id !== t.id; }) : null;
        if (bg) { killPlayer(room, bg); lines.push("🛡️ " + bg.name + " threw themself in front of an attack and died protecting someone."); return; }
        killPlayer(room, t);
        lines.push("💀 " + t.name + " was found dead this morning.");
    });

    // Alien converts (private)
    n.converts.forEach(function(c) {
        const by = room.players.find(function(p) { return p.name === c.by; });
        const t = findAliveByName(room, c.target);
        if (!t || faction(t) === "Alien") { if (by) io.to(by.id).emit("investigateResult", { result: "👽 Convert failed: the target is gone." }); return; }
        if (heal === t.name) { if (by) io.to(by.id).emit("investigateResult", { result: "👽 Convert failed: " + t.name + " was protected." }); return; }
        t.role = "Alien";
        sendRole(t);
        io.to(t.id).emit("investigateResult", { result: "👽 You were secretly converted into an Alien!" });
        if (by) io.to(by.id).emit("investigateResult", { result: "👽 " + t.name + " is now an Alien." });
    });

    // Detective / Consigliere (private)
    if (n.detectiveTarget) {
        const d = alive(room).find(function(p) { return p.role === "Detective"; });
        const t = room.players.find(function(p) { return p.name === n.detectiveTarget; });
        if (d && t) {
            const sus = faction(t) === "Mafia" && t.role !== "Godfather";
            io.to(d.id).emit("investigateResult", { result: "🔎 " + t.name + ": " + (sus ? "🔴 Suspicious" : "🟢 Not Suspicious") });
        }
    }
    if (n.consigliereTarget) {
        const c = alive(room).find(function(p) { return p.role === "Consigliere"; });
        const t = room.players.find(function(p) { return p.name === n.consigliereTarget; });
        if (c && t) io.to(c.id).emit("investigateResult", { result: "🕵️ " + t.name + ": " + ROLES[t.role].label + " (" + faction(t) + ")" });
    }

    if (!lines.length) lines.push("🌙 The night passed quietly... no one was harmed.");
    lines.forEach(function(l) { send(room, l); });

    emitPlayers(room);
    if (checkWin(room)) return;
    startDay(room);
}

// ==============================
// MORNING EVENTS
// ==============================
const MORNING_EVENTS = [
    function rumor(room) {
        const living = alive(room);
        const m = shuffle(living.filter(function(p) { return faction(p) === "Mafia"; }))[0];
        const x = shuffle(living.filter(function(p) { return faction(p) !== "Mafia"; }))[0];
        if (!m || !x) return null;
        const pair = shuffle([m.name, x.name]);
        return "📰 A rumor spreads: one of " + pair[0] + " or " + pair[1] + " is working with the Mafia.";
    },
    function tip(room) {
        const p = shuffle(alive(room).filter(function(p) { return faction(p) !== "Mafia"; }))[0];
        return p ? "📞 An anonymous tip clears " + p.name + " — they are NOT Mafia." : null;
    },
    function gunshots(room) {
        const c = room.attackCount || 0;
        return c > 0 ? "🔫 Neighbors heard " + c + " attack" + (c > 1 ? "s" : "") + " last night." : "🤫 Neighbors heard nothing at all last night.";
    },
    function curfew(room) {
        room.dayFlags.noChat = true;
        return "🚨 Curfew! Chat is closed today. Decide with what you know.";
    },
    function fireAlarm(room) {
        room.dayFlags.seconds = 45;
        return "🔥 Fire alarm! Only 45 seconds to vote today.";
    },
    function townMeeting(room) {
        room.dayFlags.randomTie = true;
        return "🏛️ Town meeting! If today's vote is tied, one of the tied players is eliminated at random.";
    }
];

function rollMorningEvent(room) {
    if (Math.random() > EVENT_CHANCE) return;
    const pool = shuffle(MORNING_EVENTS);
    for (let i = 0; i < pool.length; i++) {
        const text = pool[i](room);
        if (text) { io.to(room.code).emit("morningEvent", text); return; }
    }
}

// ==============================
// DAY
// ==============================
function startDay(room) {
    room.phase = "day";
    room.phaseId++;
    room.votes = {};
    room.dayFlags = {};
    room.dayPending = new Set();

    send(room, "🌞 DAY " + room.day);
    rollMorningEvent(room);
    io.to(room.code).emit("phase", { phase: "day", chatOpen: !room.dayFlags.noChat });

    alive(room).forEach(function(p) {
        room.dayPending.add(p.id);
        io.to(p.id).emit("voteOptions", {
            players: alive(room).filter(function(x) { return x.id !== p.id; }).map(function(x) { return x.name; })
        });
    });

    setTimer(room, room.dayFlags.seconds || DAY_SECONDS, function() { if (room.phase === "day") finishVoting(room); });
}

function finishVoting(room) {
    if (room.phase !== "day") return;
    room.phase = "resolving";
    clearTimer(room);

    const counts = {};
    Object.keys(room.votes).forEach(function(id) { const n = room.votes[id]; counts[n] = (counts[n] || 0) + 1; });

    let high = 0;
    Object.keys(counts).forEach(function(n) { if (counts[n] > high) high = counts[n]; });
    const top = Object.keys(counts).filter(function(n) { return counts[n] === high; });

    let out = null;
    if (top.length === 1) out = top[0];
    else if (top.length > 1 && room.dayFlags.randomTie) out = shuffle(top)[0];

    room.votes = {};
    room.dayPending = new Set();

    if (!out) {
        send(room, top.length > 1 ? "⚖️ The vote was a tie. Nobody was eliminated." : "🤷 Nobody voted. Nobody was eliminated.");
    } else {
        const p = findAliveByName(room, out);
        if (p) {
            killPlayer(room, p);
            send(room, "🗳️ " + p.name + " was voted out. They were the " + ROLES[p.role].label + ".");
            emitPlayers(room);
            if (p.role === "Jester") { endGame(room, "Jester", p); return; }
        }
    }

    emitPlayers(room);
    if (checkWin(room)) return;
    room.day++;
    startNight(room);
}

// ==============================
// LEAVING / BAN
// ==============================
function removePlayerMidGame(room, p, msg) {
    if (!p.alive) return;
    killPlayer(room, p);
    send(room, msg);
    emitPlayers(room);
    if (checkWin(room)) return;
    if (room.phase === "night" && room.pendingActions) {
        room.pendingActions.delete(p.id);
        if (room.pendingActions.size === 0) resolveNight(room);
    } else if (room.phase === "day" && room.dayPending) {
        room.dayPending.delete(p.id);
        if (room.dayPending.size === 0) finishVoting(room);
    }
}

function pickNewHost(room) {
    const h = room.players.find(function(p) { return p.alive; }) || room.players[0];
    if (h) { room.hostId = h.id; io.to(room.code).emit("host", room.hostId); }
}

// ==============================
// SOCKETS
// ==============================
io.on("connection", function(socket) {

    socket.on("createRoom", function(name) {
        if (!name || !name.trim()) { socket.emit("errorMessage", "Enter your name."); return; }
        let code;
        do { code = makeCode(); } while (rooms[code]);
        const room = rooms[code] = {
            code: code, hostId: socket.id, players: [], started: false, phase: "lobby", phaseId: 0, day: 1,
            votes: {}, night: {}, pendingActions: new Set(), dayPending: new Set(), dayFlags: {},
            convertUsed: false, attackCount: 0, bannedNames: new Set(), timer: null
        };
        room.players.push({ id: socket.id, name: name.trim().slice(0, MAX_NAME_LEN), role: null, alive: true, lastChat: 0 });
        socket.join(code);
        socket.room = code;
        socket.emit("roomCreated", code);
        emitPlayers(room);
        io.to(code).emit("host", room.hostId);
    });

    socket.on("joinRoom", function(data) {
        if (!data || !data.code || !data.name || !data.name.trim()) { socket.emit("errorMessage", "Enter a room code and name."); return; }
        const room = rooms[data.code.toUpperCase().trim()];
        const name = data.name.trim().slice(0, MAX_NAME_LEN);
        if (!room) { socket.emit("errorMessage", "Room doesn't exist."); return; }
        if (room.started) { socket.emit("errorMessage", "Game already started."); return; }
        if (room.bannedNames.has(name.toLowerCase())) { socket.emit("errorMessage", "You are banned from this room."); return; }
        if (room.players.length >= MAX_PLAYERS) { socket.emit("errorMessage", "Room is full (" + MAX_PLAYERS + " max)."); return; }
        if (room.players.some(function(p) { return p.name.toLowerCase() === name.toLowerCase(); })) {
            socket.emit("errorMessage", "That name is already being used."); return;
        }
        room.players.push({ id: socket.id, name: name, role: null, alive: true, lastChat: 0 });
        socket.join(room.code);
        socket.room = room.code;
        socket.emit("joinedRoom", room.code);
        emitPlayers(room);
        io.to(room.code).emit("host", room.hostId);
    });

    socket.on("startGame", function() {
        const room = rooms[socket.room];
        if (!room || room.started) return;
        if (socket.id !== room.hostId) { socket.emit("errorMessage", "Only the room creator can start the game."); return; }
        if (room.players.length < MIN_PLAYERS) { socket.emit("errorMessage", "You need at least " + MIN_PLAYERS + " players."); return; }
        startGame(room);
    });

    socket.on("banPlayer", function(name) {
        const room = rooms[socket.room];
        if (!room || socket.id !== room.hostId || !name) return;
        const t = room.players.find(function(p) { return p.name === name; });
        if (!t) return;
        if (t.id === socket.id) { socket.emit("errorMessage", "You can't ban yourself."); return; }
        room.bannedNames.add(t.name.toLowerCase());
        io.to(t.id).emit("banned");
        const ts = io.sockets.sockets.get(t.id);
        if (ts) { ts.leave(room.code); ts.leave(mafiaRoom(room)); ts.room = null; }
        if (room.started) {
            removePlayerMidGame(room, t, "🚫 " + t.name + " was banned by the host.");
        } else {
            room.players = room.players.filter(function(p) { return p.id !== t.id; });
            emitPlayers(room);
        }
    });

    function chatChecks(room, player) {
        if (!player || !room) return false;
        const now = Date.now();
        if (now - player.lastChat < CHAT_COOLDOWN_MS) { socket.emit("errorMessage", "⏳ Slow down! Wait a moment before sending another message."); return false; }
        player.lastChat = now;
        return true;
    }

    socket.on("chat", function(text) {
        const room = rooms[socket.room];
        if (!room || typeof text !== "string" || !text.trim()) return;
        const player = room.players.find(function(p) { return p.id === socket.id; });
        if (!player) return;
        if (room.started && !player.alive) return;
        if (room.phase === "night" || room.phase === "resolving") { socket.emit("errorMessage", "🌙 You cannot chat right now."); return; }
        if (room.phase === "day" && room.dayFlags.noChat) { socket.emit("errorMessage", "🚨 Curfew: chat is closed today."); return; }
        if (!chatChecks(room, player)) return;
        io.to(room.code).emit("chat", { name: player.name, text: text.trim().slice(0, MAX_CHAT_LEN) });
    });

    socket.on("mafiaChat", function(text) {
        const room = rooms[socket.room];
        if (!room || !room.started || typeof text !== "string" || !text.trim()) return;
        const player = room.players.find(function(p) { return p.id === socket.id; });
        if (!player || !player.alive || faction(player) !== "Mafia") return;
        if (!chatChecks(room, player)) return;
        io.to(mafiaRoom(room)).emit("mafiaChat", { name: player.name, text: text.trim().slice(0, MAX_CHAT_LEN) });
    });

    socket.on("nightAction", function(data) {
        const room = rooms[socket.room];
        if (!room || room.phase !== "night" || !data || !data.type || !data.target) return;
        const player = room.players.find(function(p) { return p.id === socket.id; });
        if (!player || !player.alive || !room.pendingActions.has(socket.id)) return;
        const n = room.night;
        const actor = getMafiaActor(room);

        // Alien step 1: choose mode
        if (data.type === "alienMode") {
            if (player.role !== "Alien") return;
            const targets = alienTargets(room, player);
            if (data.target === CONVERT && !room.convertUsed) {
                io.to(socket.id).emit("nightAction", { type: "alienConvert", title: "👽 Choose someone to convert:", players: targets });
            } else {
                io.to(socket.id).emit("nightAction", { type: "alienAbduct", title: "👽 Choose someone to abduct:", players: targets });
            }
            return;
        }

        const ok =
            (data.type === "mafiaKill" && actor && actor.id === player.id) ||
            (data.type === "skKill" && player.role === "SerialKiller") ||
            (data.type === "heal" && player.role === "Doctor") ||
            (data.type === "investigate" && player.role === "Detective") ||
            (data.type === "investigateRole" && player.role === "Consigliere") ||
            (data.type === "guard" && player.role === "Bodyguard") ||
            ((data.type === "alienAbduct" || data.type === "alienConvert") && player.role === "Alien");
        if (!ok) return;

        const t = findAliveByName(room, data.target);
        if (!t) return;
        if (data.type !== "heal" && t.id === player.id) return;
        if (data.type === "mafiaKill" && faction(t) === "Mafia") return;
        if ((data.type === "alienAbduct" || data.type === "alienConvert") && faction(t) === "Alien") return;

        if (data.type === "alienConvert") {
            if (room.convertUsed) { // teammate already spent the shared charge this night
                io.to(socket.id).emit("nightAction", { type: "alienAbduct", title: "👽 Convert was already used. Choose someone to abduct:", players: alienTargets(room, player) });
                return;
            }
            room.convertUsed = true;
            n.converts.push({ by: player.name, target: t.name });
        }
        if (data.type === "alienAbduct") n.attacks.push(t.name);
        if (data.type === "mafiaKill") n.mafiaTarget = t.name;
        if (data.type === "skKill") n.skTarget = t.name;
        if (data.type === "heal") n.healTarget = t.name;
        if (data.type === "guard") n.guardTarget = t.name;
        if (data.type === "investigate") n.detectiveTarget = t.name;
        if (data.type === "investigateRole") n.consigliereTarget = t.name;

        room.pendingActions.delete(socket.id);
        socket.emit("waiting", "⏳ Waiting for the night to finish...");
        if (room.pendingActions.size === 0) resolveNight(room);
    });

    socket.on("vote", function(name) {
        const room = rooms[socket.room];
        if (!room || room.phase !== "day" || !room.dayPending.has(socket.id)) return;
        const voter = room.players.find(function(p) { return p.id === socket.id; });
        const t = findAliveByName(room, name);
        if (!voter || !voter.alive || !t || t.id === voter.id) return;
        room.votes[socket.id] = t.name;
        room.dayPending.delete(socket.id);
        socket.emit("waiting", "🗳️ Vote submitted. Waiting for everyone...");
        if (room.dayPending.size === 0) finishVoting(room);
    });

    socket.on("disconnect", function() {
        const room = rooms[socket.room];
        if (!room) return;
        const p = room.players.find(function(x) { return x.id === socket.id; });
        if (!p) return;

        if (!room.started) {
            room.players = room.players.filter(function(x) { return x.id !== socket.id; });
            if (room.players.length === 0) { clearTimer(room); delete rooms[room.code]; return; }
            emitPlayers(room);
            if (socket.id === room.hostId) pickNewHost(room);
            return;
        }

        const wasHost = socket.id === room.hostId;
        removePlayerMidGame(room, p, "🔌 " + p.name + " disconnected and is out of the game.");
        if (rooms[room.code] && wasHost) pickNewHost(room);
        if (rooms[room.code] && room.players.every(function(x) { return !io.sockets.sockets.get(x.id); })) {
            clearTimer(room); delete rooms[room.code];
        }
    });
});

server.listen(3000, "0.0.0.0", function() {
    console.log("Mafia server running at http://localhost:3000");
});
