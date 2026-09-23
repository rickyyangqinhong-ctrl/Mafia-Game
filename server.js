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


// ==============================
// LOCATIONS
// ==============================
// The world players move through at night. Evidence of who went where
// is what Guard/Tracker/Investigate all draw from.

const LOCATIONS = {
    "Hospital": "🏥",
    "Park": "🌳",
    "Shop": "🛒",
    "Police Station": "👮",
    "Docks": "⚓",
    "Bank": "🏦"
};

const LOCATION_NAMES = Object.keys(LOCATIONS);


// ==============================
// ROLES
// ==============================

const ROLES = {

    Godfather: {
        faction: "Mafia",
        label: "🕴️ Godfather",
        description: "Each night, choose a kill target and the location where it happens. Detectives see you as innocent."
    },

    Consigliere: {
        faction: "Mafia",
        label: "🕵️ Consigliere",
        description: "Each night you wake up at a random location. Stay and learn a player's exact role, or move to a new location (giving up the check)."
    },

    Mafia: {
        faction: "Mafia",
        label: "🔪 Mafia",
        description: "If the Godfather is dead you lead the kill. Otherwise, sabotage a location each night to disable cameras and tamper with evidence there."
    },

    Villager: {
        faction: "Innocent",
        label: "👤 Villager",
        description: "No special power. Each night choose a location to visit — your movements can become evidence."
    },

    Doctor: {
        faction: "Innocent",
        label: "💉 Doctor",
        description: "Each night you wake up at a random location. Stay and use your ability to save someone, or move to a new location (giving up the save)."
    },

    Detective: {
        faction: "Innocent",
        label: "🔎 Detective",
        description: "Each night you wake up at a random location. Stay and investigate a player, or move to a new location (giving up the check)."
    },

    Bodyguard: {
        faction: "Innocent",
        label: "🛡️ Bodyguard",
        description: "Each night you wake up at a random location. Stay and guard a player, or move to a new location (giving up the guard)."
    },

    Guard: {
        faction: "Innocent",
        label: "📹 Guard",
        description: "Each night you wake up at a random location. Stay and check a location's camera footage, or move (giving up the check). Cameras can be disabled by the Mafia."
    },

    Tracker: {
        faction: "Innocent",
        label: "🕵️‍♂️ Tracker",
        description: "Each night you wake up at a random location. Stay and track a player's movement, or move to a new location (giving up the track)."
    },

    Jester: {
        faction: "Neutral",
        label: "🃏 Jester",
        description: "No team. You win alone if the town votes you out during the day."
    },

    SerialKiller: {
        faction: "Neutral",
        label: "🔪 Serial Killer",
        description: "Each night, eliminate someone at a location of fate's choosing. You win by being the last one standing."
    },

    Survivor: {
        faction: "Neutral",
        label: "🌿 Survivor",
        description: "No team. Lie low, visit locations quietly, and survive to the end."
    }

};

const LOCATION_ROLE_TYPES = ["mafiaLocation", "sabotage", "cameraCheck", "visit", "move"];
const FREE_ROAM_ROLES = ["Villager", "Jester", "Survivor"];

// Roles that wake up at a random location each night and must choose to
// stay (use their ability) or move (forfeit it, visit somewhere new instead).
const ROLE_ABILITY = {
    Doctor: { type: "heal", title: "💉 Choose someone to protect:", targets: "players" },
    Detective: { type: "investigate", title: "🔎 Choose someone to investigate:", targets: "players" },
    Consigliere: { type: "investigateRole", title: "🕵️ Choose someone to investigate:", targets: "players" },
    Bodyguard: { type: "guard", title: "🛡️ Choose someone to guard:", targets: "players" },
    Guard: { type: "cameraCheck", title: "📹 Choose a location to check cameras:", targets: "locations" },
    Tracker: { type: "trackMove", title: "🕵️‍♂️ Choose someone to track:", targets: "players" }
};
const STAY_OPTION = "Use ability here";
const MOVE_OPTION = "Move to another location";


// ==============================
// HELPERS
// ==============================

function makeCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function alive(room) {
    return room.players.filter(function(p) { return p.alive; });
}

function send(room, message) {
    io.to(room.code).emit("message", message);
}

function shuffle(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = copy[i]; copy[i] = copy[j]; copy[j] = t;
    }
    return copy;
}

function resetPlayers(room) {
    room.players.forEach(function(p) { p.alive = true; p.role = null; });
}

function getMafiaActor(room) {
    const livingMafia = alive(room).filter(function(p) {
        return p.role === "Godfather" || p.role === "Mafia";
    });
    const godfather = livingMafia.find(function(p) { return p.role === "Godfather"; });
    return godfather || livingMafia[0] || null;
}


// ==============================
// ROLE ASSIGNMENT
// ==============================

function getRoleList(playerCount) {

    const n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, playerCount));

    let mafiaCount = 1;
    if (n >= 9) mafiaCount = 3;
    else if (n >= 6) mafiaCount = 2;

    let neutralCount = 0;
    if (n >= 10) neutralCount = 3;
    else if (n >= 8) neutralCount = 2;
    else if (n >= 5) neutralCount = 1;

    const roles = [];

    const mafiaOrder = ["Godfather", "Consigliere", "Mafia"];
    for (let i = 0; i < mafiaCount; i++) roles.push(mafiaOrder[i]);

    const neutralOrder = ["Jester", "SerialKiller", "Survivor"];
    for (let i = 0; i < neutralCount; i++) roles.push(neutralOrder[i]);

    const innocentSpecialOrder = ["Doctor", "Detective", "Bodyguard", "Guard", "Tracker"];
    let remaining = n - roles.length;
    let idx = 0;
    while (remaining > 0 && idx < innocentSpecialOrder.length) {
        roles.push(innocentSpecialOrder[idx]);
        idx++;
        remaining--;
    }

    while (remaining > 0) { roles.push("Villager"); remaining--; }

    return roles;
}

function assignRoles(room) {
    const roleList = shuffle(getRoleList(room.players.length));
    room.players.forEach(function(p, i) { p.role = roleList[i]; });
}


// ==============================
// START / END GAME
// ==============================

function startGame(room) {

    resetPlayers(room);

    room.started = true;
    room.phase = "night";
    room.day = 1;
    room.votes = {};
    room.night = {};
    room.dayPending = new Set();
    room.pendingActions = new Set();
    room.lastNight = null;
    room.winner = null;

    assignRoles(room);

    const roleCounts = {};
    room.players.forEach(function(p) { roleCounts[p.role] = (roleCounts[p.role] || 0) + 1; });
    const poolSummary = Object.keys(roleCounts).map(function(r) {
        const c = roleCounts[r];
        return ROLES[r].label + (c > 1 ? " x" + c : "");
    }).join(", ");

    room.players.forEach(function(p) {
        io.to(p.id).emit("role", {
            role: p.role, label: ROLES[p.role].label,
            faction: ROLES[p.role].faction, description: ROLES[p.role].description
        });
        io.to(p.id).emit("gameReset");
    });

    io.to(room.code).emit("players", room.players);
    io.to(room.code).emit("gameStarted");

    send(room, "🔪 The game has started with " + room.players.length + " players!");
    send(room, "🎭 Roles: " + poolSummary);
    send(room, "🌙 NIGHT 1 — the town sleeps.");

    sendNightActions(room);
}

function endGame(room, winner, soloPlayer) {

    room.started = false;
    room.phase = "ended";
    room.winner = winner;
    room.votes = {};
    room.night = {};
    room.dayPending = new Set();
    room.pendingActions = new Set();

    let announcement;
    if (winner === "Mafia") announcement = "🔪 THE MAFIA WINS!";
    else if (winner === "Town") announcement = "👤 THE TOWN WINS!";
    else if (winner === "SerialKiller") announcement = "🔪 " + soloPlayer.name + " THE SERIAL KILLER WINS!";
    else if (winner === "Jester") announcement = "🃏 " + soloPlayer.name + " THE JESTER WINS!";
    else announcement = "Game over.";

    send(room, announcement);

    const roleReveal = room.players.map(function(p) {
        return { name: p.name, role: p.role, label: ROLES[p.role].label, faction: ROLES[p.role].faction, alive: p.alive };
    });

    io.to(room.code).emit("gameEnded", {
        winner: winner, soloWinner: soloPlayer ? soloPlayer.name : null, players: roleReveal
    });
}

function checkWin(room) {

    const living = alive(room);
    if (living.length === 0) return false;

    const mafiaLiving = living.filter(function(p) { return ROLES[p.role].faction === "Mafia"; });
    const serialKiller = living.find(function(p) { return p.role === "SerialKiller"; });
    const othersLiving = living.filter(function(p) {
        return ROLES[p.role].faction !== "Mafia" && p.role !== "SerialKiller";
    });

    if (serialKiller && living.length === 1) { endGame(room, "SerialKiller", serialKiller); return true; }
    if (mafiaLiving.length === 0 && !serialKiller) { endGame(room, "Town"); return true; }
    if (mafiaLiving.length > 0 && mafiaLiving.length >= othersLiving.length + (serialKiller ? 1 : 0)) {
        endGame(room, "Mafia");
        return true;
    }

    return false;
}


// ==============================
// NIGHT ACTIONS
// ==============================

function sendNightActions(room) {

    room.night = {};
    room.pendingActions = new Set();

    const living = alive(room);
    const acting = new Set();

    const mafiaActor = getMafiaActor(room);
    const serialKiller = living.find(function(p) { return p.role === "SerialKiller"; });

    // Random nightly spawn for every ability role (removes fixed "always at
    // the Police Station" locations that let Mafia farm easy frame-ups).
    room.night.spawns = {};
    living.forEach(function(p) {
        if (ROLE_ABILITY[p.role]) {
            room.night.spawns[p.name] = LOCATION_NAMES[Math.floor(Math.random() * LOCATION_NAMES.length)];
        }
    });

    const extraMafia = living.filter(function(p) {
        return ROLES[p.role].faction === "Mafia" && p.role !== "Consigliere" &&
            (!mafiaActor || p.id !== mafiaActor.id);
    });

    if (mafiaActor) {
        room.pendingActions.add(mafiaActor.id);
        acting.add(mafiaActor.id);
        const targets = living.filter(function(p) {
            return p.id !== mafiaActor.id && ROLES[p.role].faction !== "Mafia";
        }).map(function(p) { return p.name; });
        io.to(mafiaActor.id).emit("nightAction", { type: "mafiaKill", title: "🌙 Choose someone to eliminate:", players: targets });
    }

    extraMafia.forEach(function(p) {
        room.pendingActions.add(p.id);
        acting.add(p.id);
        io.to(p.id).emit("nightAction", { type: "sabotage", title: "🕶️ Sabotage a location (disable cameras / tamper evidence):", players: LOCATION_NAMES });
    });

    if (serialKiller) {
        room.pendingActions.add(serialKiller.id);
        acting.add(serialKiller.id);
        room.night.skLocation = LOCATION_NAMES[Math.floor(Math.random() * LOCATION_NAMES.length)];
        const targets = living.filter(function(p) { return p.id !== serialKiller.id; }).map(function(p) { return p.name; });
        io.to(serialKiller.id).emit("nightAction", { type: "skKill", title: "🔪 Choose someone to eliminate:", players: targets });
    }

    living.forEach(function(p) {
        if (ROLE_ABILITY[p.role]) {
            room.pendingActions.add(p.id);
            acting.add(p.id);
            io.to(p.id).emit("nightAction", {
                type: "roleChoice",
                title: "🌆 You woke up somewhere new tonight. Use your ability here, or move on?",
                players: [STAY_OPTION, MOVE_OPTION]
            });
        }
    });

    living.forEach(function(p) {
        if (!acting.has(p.id) && FREE_ROAM_ROLES.indexOf(p.role) !== -1) {
            room.pendingActions.add(p.id);
            acting.add(p.id);
            io.to(p.id).emit("nightAction", { type: "visit", title: "🌆 Choose where to go tonight:", players: LOCATION_NAMES });
        }
    });

    living.forEach(function(p) {
        if (!acting.has(p.id)) io.to(p.id).emit("waiting", "🌙 Night falls... others are taking action.");
    });

    if (room.pendingActions.size === 0) resolveNight(room);
}

function buildVisits(room) {

    const visits = {};
    function addVisit(loc, name) {
        if (!loc || !name) return;
        if (!visits[loc]) visits[loc] = [];
        visits[loc].push(name);
    }

    const living = alive(room);
    const moves = room.night.moves || {};
    const spawns = room.night.spawns || {};

    living.forEach(function(p) {
        if (!ROLE_ABILITY[p.role]) return;
        const loc = moves[p.name] || spawns[p.name];
        if (loc) addVisit(loc, p.name);
    });

    const actor = getMafiaActor(room);
    if (room.night.mafiaLocation && actor) addVisit(room.night.mafiaLocation, actor.name);

    (room.night.sabotages || []).forEach(function(s) { addVisit(s.location, s.name); });

    if (room.night.skLocation) {
        const sk = living.find(function(p) { return p.role === "SerialKiller"; });
        if (sk) addVisit(room.night.skLocation, sk.name);
    }

    const vc = room.night.visitChoices || {};
    Object.keys(vc).forEach(function(name) { addVisit(vc[name], name); });

    return visits;
}

function resolveNight(room) {

    const night = room.night;
    function findAlive(name) { return room.players.find(function(p) { return p.alive && p.name === name; }); }

    const mafiaTarget = night.mafiaKillTarget ? findAlive(night.mafiaKillTarget) : null;
    const skTarget = night.skKillTarget ? findAlive(night.skKillTarget) : null;
    const healTarget = night.healTarget ? findAlive(night.healTarget) : null;
    const guardTarget = night.guardTarget ? findAlive(night.guardTarget) : null;

    let doctorSaved = false;

    function applyKill(target) {
        if (!target || !target.alive) return null;
        if (healTarget && healTarget.id === target.id && !doctorSaved) {
            doctorSaved = true;
            return { type: "saved", target: target };
        }
        if (guardTarget && guardTarget.id === target.id) {
            const bg = alive(room).find(function(p) { return p.role === "Bodyguard"; });
            if (bg) { bg.alive = false; return { type: "guarded", target: target, bodyguard: bg }; }
        }
        target.alive = false;
        return { type: "killed", target: target };
    }

    const mafiaResult = applyKill(mafiaTarget);
    const skResult = applyKill(skTarget);

    const visits = buildVisits(room);
    const sabotagedLocations = (night.sabotages || []).map(function(s) { return s.location; });

    room.lastNight = {
        visits: visits,
        sabotagedLocations: sabotagedLocations,
        mafiaLocation: night.mafiaLocation || null,
        mafiaKilled: !!(mafiaResult && mafiaResult.type === "killed"),
        skLocation: night.skLocation || null,
        skKilled: !!(skResult && skResult.type === "killed")
    };

    if (!mafiaResult && !skResult) {
        send(room, "🌙 The night passed quietly... no one was harmed.");
    }

    [mafiaResult, skResult].forEach(function(r) {
        if (!r) return;
        if (r.type === "killed") send(room, "💀 " + r.target.name + " was found dead this morning.");
        if (r.type === "guarded") send(room, "🛡️ " + r.bodyguard.name + " threw themself in front of an attack and paid with their life.");
        if (r.type === "saved") send(room, "💉 Someone was attacked in the night, but the Doctor saved them!");
    });

    // Detective
    if (night.detectiveTarget) {
        const detective = alive(room).find(function(p) { return p.role === "Detective"; });
        const target = room.players.find(function(p) { return p.name === night.detectiveTarget; });
        if (detective && target) {
            const suspicious = ROLES[target.role].faction === "Mafia" && target.role !== "Godfather";
            io.to(detective.id).emit("investigateResult", {
                result: "🔎 " + target.name + ": " + (suspicious ? "🔴 Suspicious" : "🟢 Not Suspicious")
            });
        }
    }

    // Consigliere
    if (night.consigliereTarget) {
        const consigliere = alive(room).find(function(p) { return p.role === "Consigliere"; });
        const target = room.players.find(function(p) { return p.name === night.consigliereTarget; });
        if (consigliere && target) {
            io.to(consigliere.id).emit("investigateResult", {
                result: "🕵️ " + target.name + ": " + ROLES[target.role].label + " (" + ROLES[target.role].faction + ")"
            });
        }
    }

    // Guard camera check
    if (night.cameraCheckLocation) {
        const guardPlayer = alive(room).find(function(p) { return p.role === "Guard"; });
        if (guardPlayer) {
            const loc = night.cameraCheckLocation;
            let text;
            if (sabotagedLocations.indexOf(loc) !== -1) {
                text = "📹 " + loc + ": Cameras were disabled. No footage available.";
            } else {
                const names = (visits[loc] || []).filter(function(n) { return n !== guardPlayer.name; });
                text = names.length ? ("📹 " + loc + " — seen on camera: " + names.join(", ")) : ("📹 " + loc + ": No one visited last night.");
            }
            io.to(guardPlayer.id).emit("investigateResult", { result: text });
        }
    }

    // Tracker
    if (night.trackMoveTarget) {
        const trackerPlayer = alive(room).find(function(p) { return p.role === "Tracker"; });
        const targetPlayer = room.players.find(function(p) { return p.name === night.trackMoveTarget; });
        if (trackerPlayer && targetPlayer) {
            let foundLoc = null;
            for (const loc in visits) {
                if (visits[loc].indexOf(targetPlayer.name) !== -1) { foundLoc = loc; break; }
            }
            const text = foundLoc
                ? ("🕵️‍♂️ " + targetPlayer.name + " was tracked to " + foundLoc + " last night.")
                : ("🕵️‍♂️ Couldn't pin down where " + targetPlayer.name + " went.");
            io.to(trackerPlayer.id).emit("investigateResult", { result: text });
        }
    }

    room.night = {};
    room.pendingActions = new Set();

    io.to(room.code).emit("players", room.players);

    if (checkWin(room)) return;

    startDay(room);
}


// ==============================
// DAY: VOTE OR INVESTIGATE
// ==============================

function voteTargetsFor(room, player) {
    return alive(room).filter(function(p) { return p.id !== player.id; }).map(function(p) { return p.name; });
}

function sendVoteOptionsTo(room, player) {
    io.to(player.id).emit("voteOptions", { players: voteTargetsFor(room, player) });
}

function startDay(room) {

    room.phase = "day";
    room.votes = {};
    room.dayPending = new Set();

    const living = alive(room);

    living.forEach(function(p) {
        room.dayPending.add(p.id);
        if (ROLES[p.role].faction === "Mafia") {
            sendVoteOptionsTo(room, p);
        } else {
            io.to(p.id).emit("dayChoice", {});
        }
    });

    send(room, "🌞 DAY " + room.day);
    send(room, "Discuss, then 🗳️ Vote or 🔍 Investigate a location for clues.");
}

function getInvestigateClue(room, locationName) {

    const ln = room.lastNight;
    if (!ln) return "🔍 " + locationName + ": Nothing to report.";

    const sabotaged = ln.sabotagedLocations.indexOf(locationName) !== -1;
    const isMafiaScene = ln.mafiaKilled && ln.mafiaLocation === locationName;
    const isSkScene = ln.skKilled && ln.skLocation === locationName;
    const visitors = ln.visits[locationName] || [];

    if (sabotaged) {
        return "🔍 " + locationName + ": The evidence here has been tampered with. Nothing conclusive.";
    }

    if (isMafiaScene || isSkScene) {
        return visitors.length
            ? ("🔍 " + locationName + ": This is where last night's crime took place! Seen here: " + visitors.join(", ") + ".")
            : ("🔍 " + locationName + ": This is where last night's crime took place, but no witnesses were seen.");
    }

    if (visitors.length === 0) {
        return "🔍 " + locationName + ": Quiet night — no one seems to have passed through.";
    }

    return "🔍 " + locationName + ": Seen passing through — " + visitors.join(", ") + ".";
}

function finishVoting(room) {

    const counts = {};
    Object.values(room.votes).forEach(function(name) { counts[name] = (counts[name] || 0) + 1; });

    let highest = 0, eliminatedName = null, tie = false;
    for (const name in counts) {
        if (counts[name] > highest) { highest = counts[name]; eliminatedName = name; tie = false; }
        else if (counts[name] === highest) { tie = true; }
    }

    room.votes = {};
    room.dayPending = new Set();

    if (tie || !eliminatedName) {
        send(room, "⚖️ The vote was a tie. Nobody was eliminated.");
    } else {
        const eliminated = room.players.find(function(p) { return p.name === eliminatedName && p.alive; });
        if (eliminated) {
            eliminated.alive = false;
            send(room, "🗳️ " + eliminated.name + " was voted out. They were the " + ROLES[eliminated.role].label + ".");
            io.to(room.code).emit("players", room.players);
            if (eliminated.role === "Jester") { endGame(room, "Jester", eliminated); return; }
        }
    }

    io.to(room.code).emit("players", room.players);
    if (checkWin(room)) return;

    room.day++;
    room.phase = "night";
    send(room, "🌙 NIGHT " + room.day + " — the town sleeps.");
    sendNightActions(room);
}


// ==============================
// CONNECTION
// ==============================

io.on("connection", function(socket) {

    socket.on("createRoom", function(name) {

        if (!name || !name.trim()) { socket.emit("errorMessage", "Enter your name."); return; }

        let code;
        do { code = makeCode(); } while (rooms[code]);

        rooms[code] = {
            code: code, hostId: socket.id, players: [], started: false, phase: "lobby",
            day: 1, votes: {}, night: {}, dayPending: new Set(), pendingActions: new Set(),
            lastNight: null, winner: null
        };

        rooms[code].players.push({ id: socket.id, name: name.trim().slice(0, MAX_NAME_LEN), role: null, alive: true });

        socket.join(code);
        socket.room = code;
        socket.emit("roomCreated", code);
        io.to(code).emit("players", rooms[code].players);
        io.to(code).emit("host", rooms[code].hostId);
    });

    socket.on("joinRoom", function(data) {

        if (!data || !data.code || !data.name) { socket.emit("errorMessage", "Enter a room code and name."); return; }

        const code = data.code.toUpperCase().trim();
        const name = data.name.trim().slice(0, MAX_NAME_LEN);
        const room = rooms[code];

        if (!room) { socket.emit("errorMessage", "Room doesn't exist."); return; }
        if (room.started) { socket.emit("errorMessage", "Game already started."); return; }
        if (room.players.length >= MAX_PLAYERS) { socket.emit("errorMessage", "Room is full. Maximum " + MAX_PLAYERS + " players."); return; }
        if (room.players.some(function(p) { return p.name.toLowerCase() === name.toLowerCase(); })) {
            socket.emit("errorMessage", "That name is already being used.");
            return;
        }

        room.players.push({ id: socket.id, name: name, role: null, alive: true });
        socket.join(code);
        socket.room = code;
        socket.emit("joinedRoom", code);
        io.to(code).emit("players", room.players);
        io.to(code).emit("host", room.hostId);
    });

    socket.on("startGame", function() {
        const room = rooms[socket.room];
        if (!room) return;
        if (socket.id !== room.hostId) { socket.emit("errorMessage", "Only the room creator can start the game."); return; }
        if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) {
            socket.emit("errorMessage", "You need between " + MIN_PLAYERS + " and " + MAX_PLAYERS + " players.");
            return;
        }
        if (room.started) return;
        startGame(room);
    });

    socket.on("chat", function(text) {
        const room = rooms[socket.room];
        if (!room) return;
        const player = room.players.find(function(p) { return p.id === socket.id; });
        if (!player || !player.alive) return;
        if (room.phase === "night") { socket.emit("errorMessage", "🌙 You cannot chat during the night."); return; }
        if (room.phase !== "lobby" && room.phase !== "day") return;
        if (!text || !text.trim()) return;
        io.to(room.code).emit("chat", { name: player.name, text: text.trim().slice(0, MAX_CHAT_LEN) });
    });

    // ---- NIGHT ACTIONS (kill, sabotage, camera check, track, visit, heal, guard, investigate) ----
    socket.on("nightAction", function(data) {

        const room = rooms[socket.room];
        if (!room || room.phase !== "night") return;
        if (!data || !data.type || !data.target) return;

        const player = room.players.find(function(p) { return p.id === socket.id; });
        if (!player || !player.alive) return;
        if (!room.pendingActions || !room.pendingActions.has(socket.id)) return;

        const mafiaActor = getMafiaActor(room);
        const isActor = !!(mafiaActor && mafiaActor.id === player.id);

        // Step 1 for the six "wake up somewhere random" roles: stay & use
        // ability, or move & forfeit it. Handled before generic validation
        // since its target is a fixed phrase, not a player/location name.
        if (data.type === "roleChoice") {
            const ability = ROLE_ABILITY[player.role];
            if (!ability) return;

            if (data.target === STAY_OPTION) {
                const targets = ability.targets === "locations"
                    ? LOCATION_NAMES
                    : alive(room).filter(function(p) { return p.id !== player.id; }).map(function(p) { return p.name; });
                io.to(socket.id).emit("nightAction", { type: ability.type, title: ability.title, players: targets });
                return; // still pending — waiting on the real ability choice
            }
            if (data.target === MOVE_OPTION) {
                io.to(socket.id).emit("nightAction", { type: "move", title: "🚶 Choose where to move:", players: LOCATION_NAMES });
                return; // still pending — waiting on the destination
            }
            return;
        }

        const validType =
            (data.type === "mafiaKill" && isActor) ||
            (data.type === "mafiaLocation" && isActor && !!room.night.mafiaKillTarget) ||
            (data.type === "sabotage" && ROLES[player.role].faction === "Mafia" && player.role !== "Consigliere" && !isActor) ||
            (data.type === "skKill" && player.role === "SerialKiller") ||
            (data.type === "heal" && player.role === "Doctor") ||
            (data.type === "investigate" && player.role === "Detective") ||
            (data.type === "investigateRole" && player.role === "Consigliere") ||
            (data.type === "guard" && player.role === "Bodyguard") ||
            (data.type === "cameraCheck" && player.role === "Guard") ||
            (data.type === "trackMove" && player.role === "Tracker") ||
            (data.type === "visit" && FREE_ROAM_ROLES.indexOf(player.role) !== -1) ||
            (data.type === "move" && !!ROLE_ABILITY[player.role]);

        if (!validType) return;

        let targetName;
        if (LOCATION_ROLE_TYPES.indexOf(data.type) !== -1) {
            if (LOCATION_NAMES.indexOf(data.target) === -1) return;
            targetName = data.target;
        } else {
            const t = room.players.find(function(p) { return p.name === data.target && p.alive; });
            if (!t) return;
            targetName = t.name;
        }

        if (data.type === "mafiaKill") {
            room.night.mafiaKillTarget = targetName;
            io.to(socket.id).emit("nightAction", { type: "mafiaLocation", title: "🌆 Where will it happen?", players: LOCATION_NAMES });
            return; // stays pending for step 2
        }

        if (data.type === "mafiaLocation") room.night.mafiaLocation = targetName;
        if (data.type === "sabotage") {
            room.night.sabotages = room.night.sabotages || [];
            room.night.sabotages.push({ name: player.name, location: targetName });
        }
        if (data.type === "skKill") room.night.skKillTarget = targetName;
        if (data.type === "heal") room.night.healTarget = targetName;
        if (data.type === "investigate") room.night.detectiveTarget = targetName;
        if (data.type === "investigateRole") room.night.consigliereTarget = targetName;
        if (data.type === "guard") room.night.guardTarget = targetName;
        if (data.type === "cameraCheck") room.night.cameraCheckLocation = targetName;
        if (data.type === "trackMove") room.night.trackMoveTarget = targetName;
        if (data.type === "visit") {
            room.night.visitChoices = room.night.visitChoices || {};
            room.night.visitChoices[player.name] = targetName;
        }
        if (data.type === "move") {
            room.night.moves = room.night.moves || {};
            room.night.moves[player.name] = targetName;
        }

        room.pendingActions.delete(socket.id);
        socket.emit("waiting", "⏳ Waiting for the night to finish...");
        if (room.pendingActions.size === 0) resolveNight(room);
    });

    // ---- DAY: choose Vote or Investigate ----
    socket.on("dayChoice", function(data) {
        const room = rooms[socket.room];
        if (!room || room.phase !== "day") return;
        const player = room.players.find(function(p) { return p.id === socket.id; });
        if (!player || !player.alive) return;
        if (!room.dayPending || !room.dayPending.has(socket.id)) return;
        if (ROLES[player.role].faction === "Mafia") return;

        if (data && data.choice === "vote") {
            sendVoteOptionsTo(room, player);
        } else if (data && data.choice === "investigate") {
            io.to(player.id).emit("locationOptions", { title: "🔍 Choose a location to investigate:", locations: LOCATION_NAMES });
        }
    });

    socket.on("investigateChoice", function(locationName) {
        const room = rooms[socket.room];
        if (!room || room.phase !== "day") return;
        const player = room.players.find(function(p) { return p.id === socket.id; });
        if (!player || !player.alive) return;
        if (!room.dayPending || !room.dayPending.has(socket.id)) return;
        if (!LOCATIONS[locationName]) return;

        const clue = getInvestigateClue(room, locationName);
        io.to(player.id).emit("investigateResult", { result: clue });

        room.dayPending.delete(socket.id);
        if (room.dayPending.size === 0) finishVoting(room);
    });

    socket.on("vote", function(targetName) {
        const room = rooms[socket.room];
        if (!room || room.phase !== "day") return;
        const voter = room.players.find(function(p) { return p.id === socket.id; });
        if (!voter || !voter.alive) return;
        if (room.votes[socket.id]) return;
        if (!room.dayPending || !room.dayPending.has(socket.id)) return;

        const target = room.players.find(function(p) { return p.name === targetName && p.alive; });
        if (!target || target.id === voter.id) return;

        room.votes[socket.id] = targetName;
        room.dayPending.delete(socket.id);
        io.to(voter.id).emit("waiting", "🗳️ Vote submitted. Waiting for everyone...");
        if (room.dayPending.size === 0) finishVoting(room);
    });

    socket.on("disconnect", function() {

        const room = rooms[socket.room];
        if (!room) return;

        if (!room.started && room.phase !== "ended" && socket.id === room.hostId) {
            io.to(room.code).emit("errorMessage", "The room creator left. The room has been closed.");
            delete rooms[room.code];
            return;
        }

        if (!room.started) {
            room.players = room.players.filter(function(p) { return p.id !== socket.id; });
            if (room.players.length === 0) { delete rooms[room.code]; return; }
            io.to(room.code).emit("players", room.players);
            return;
        }

        const player = room.players.find(function(p) { return p.id === socket.id; });
        if (player && player.alive) {
            player.alive = false;
            send(room, "🔌 " + player.name + " disconnected and is out of the game.");
            io.to(room.code).emit("players", room.players);

            if (checkWin(room)) return;

            if (room.phase === "night" && room.pendingActions) {
                room.pendingActions.delete(socket.id);
                if (room.pendingActions.size === 0) resolveNight(room);
            }

            if (room.phase === "day" && room.dayPending) {
                room.dayPending.delete(socket.id);
                if (room.dayPending.size === 0) finishVoting(room);
            }
        }

        if (socket.id === room.hostId) {
            const newHost = room.players.find(function(p) { return p.alive; }) || room.players[0];
            if (newHost) { room.hostId = newHost.id; io.to(room.code).emit("host", room.hostId); }
        }
    });

});

server.listen(3000, "0.0.0.0", function() {
    console.log("Mafia server running at http://localhost:3000");
});