const socket = io();

const MAX_CHAT_LEN = 240;

let myRole = null;
let myName = "";
let hostId = null;
let amDead = false;
let lastPlayers = [];
let timerInterval = null;

const $ = function(id) { return document.getElementById(id); };
const menu = $("menu"), lobby = $("lobby"), nameInput = $("nameInput"), roomInput = $("roomInput");
const chatLog = $("chatLog"), chatInput = $("chatInput"), chatCounter = $("chatCounter");
const mafiaPanel = $("mafiaPanel"), mafiaLog = $("mafiaLog"), mafiaInput = $("mafiaInput"), mafiaCounter = $("mafiaCounter");
const roleDiv = $("role"), startButton = $("startButton"), playersDiv = $("players"), timerDiv = $("timer");

// ---------- screens / setup ----------
function showLobby(code) {
    menu.style.display = "none";
    lobby.style.display = "block";
    $("roomCode").textContent = code;
    roleDiv.innerHTML = "";
    setChat(true);
}

function createRoom() {
    const name = nameInput.value.trim();
    if (!name) { alert("Enter your name."); return; }
    myName = name.slice(0, 16);
    socket.emit("createRoom", name);
}

function joinRoom() {
    const name = nameInput.value.trim(), code = roomInput.value.trim().toUpperCase();
    if (!name) { alert("Enter your name."); return; }
    if (!code) { alert("Enter a room code."); return; }
    myName = name.slice(0, 16);
    socket.emit("joinRoom", { code: code, name: name });
}

function startGame() { socket.emit("startGame"); }
function banPlayer(name) { if (confirm("Ban " + name + " from this room?")) socket.emit("banPlayer", name); }

// ---------- chat ----------
function setChat(open, placeholder) {
    const on = open && !amDead;
    chatInput.disabled = !on;
    chatInput.placeholder = on ? "Type a message..." : (amDead ? "You are eliminated 💀" : (placeholder || "Chat is closed 🌙"));
}

function sendChat() {
    const t = chatInput.value.trim();
    if (!t || chatInput.disabled) return;
    socket.emit("chat", t.slice(0, MAX_CHAT_LEN));
    chatInput.value = "";
    counter(chatInput, chatCounter);
}

function sendMafiaChat() {
    const t = mafiaInput.value.trim();
    if (!t) return;
    socket.emit("mafiaChat", t.slice(0, MAX_CHAT_LEN));
    mafiaInput.value = "";
    counter(mafiaInput, mafiaCounter);
}

function counter(input, el) { el.textContent = input.value.length + " / " + MAX_CHAT_LEN; }

function addLine(log, text, cls) {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
}

// ---------- action panel ----------
function factionClass(f) {
    return { Mafia: "faction-mafia", Innocent: "faction-innocent", Alien: "faction-alien" }[f] || "faction-neutral";
}

function renderRoleCard() {
    if (!myRole) return;
    const card = document.createElement("div");
    card.className = "role-card " + factionClass(myRole.faction);
    [["role-name", myRole.label], ["role-faction", myRole.faction + " faction"], ["role-desc", myRole.description]].forEach(function(r) {
        const d = document.createElement("div");
        d.className = r[0];
        d.textContent = r[1];
        card.appendChild(d);
    });
    roleDiv.appendChild(card);
}

function showWaiting(text) {
    roleDiv.innerHTML = "";
    renderRoleCard();
    const m = document.createElement("div");
    m.className = "waiting-text";
    m.textContent = text;
    roleDiv.appendChild(m);
}

function renderButtons(title, options, onPick) {
    roleDiv.innerHTML = "";
    renderRoleCard();
    const t = document.createElement("div");
    t.className = "action-title";
    t.textContent = title;
    roleDiv.appendChild(t);
    options.forEach(function(o) {
        const b = document.createElement("button");
        b.className = "action-btn";
        b.textContent = o;
        b.onclick = function() { onPick(o); };
        roleDiv.appendChild(b);
    });
}

function renderPlayers() {
    playersDiv.innerHTML = "";
    const amHost = hostId === socket.id;
    lastPlayers.forEach(function(p) {
        const row = document.createElement("div");
        row.className = "player-row" + (p.alive ? "" : " dead");
        const label = document.createElement("span");
        label.textContent = (p.alive ? "🟢 " : "💀 ") + p.name;
        row.appendChild(label);
        if (amHost && p.name !== myName) {
            const b = document.createElement("button");
            b.className = "ban-btn";
            b.textContent = "✕";
            b.title = "Ban " + p.name;
            b.onclick = function() { banPlayer(p.name); };
            row.appendChild(b);
        }
        playersDiv.appendChild(row);
    });
    $("playerCount").textContent = lastPlayers.length + (lastPlayers.length === 1 ? " player" : " players");
}

// ---------- socket events ----------
socket.on("roomCreated", showLobby);
socket.on("joinedRoom", showLobby);

socket.on("players", function(list) { lastPlayers = list; renderPlayers(); });

socket.on("host", function(id) {
    hostId = id;
    renderPlayers();
    startButton.style.display = id === socket.id ? "inline-block" : "none";
    startButton.textContent = "Start Game";
});

socket.on("gameStarted", function() { startButton.style.display = "none"; });

socket.on("role", function(role) {
    myRole = role;
    roleDiv.innerHTML = "";
    renderRoleCard();
    mafiaPanel.style.display = role.faction === "Mafia" ? "block" : "none";
});

socket.on("gameReset", function() {
    amDead = false;
    mafiaLog.innerHTML = "";
    setChat(false);
});

socket.on("phase", function(d) { setChat(d.chatOpen, d.phase === "day" ? "🚨 Chat is closed today" : "Chat is closed at night 🌙"); });

socket.on("message", function(m) { addLine(chatLog, m, "chat-system"); });
socket.on("morningEvent", function(m) { addLine(chatLog, "🌅 MORNING EVENT: " + m, "chat-event"); });
socket.on("chat", function(d) { addLine(chatLog, d.name + ": " + d.text); });
socket.on("mafiaChat", function(d) { addLine(mafiaLog, d.name + ": " + d.text); });
socket.on("investigateResult", function(d) { addLine(chatLog, d.result, "chat-clue"); });
socket.on("errorMessage", function(m) { alert(m); });

socket.on("nightAction", function(d) {
    renderButtons(d.title, d.players, function(pick) {
        showWaiting("⏳ Waiting...");
        socket.emit("nightAction", { type: d.type, target: pick });
    });
});

socket.on("voteOptions", function(d) {
    renderButtons("🌞 Vote for someone to eliminate:", d.players, function(pick) {
        showWaiting("⏳ Vote submitted. Waiting for everyone...");
        socket.emit("vote", pick);
    });
});

socket.on("waiting", showWaiting);

socket.on("eliminated", function() {
    amDead = true;
    setChat(false);
    roleDiv.innerHTML = "";
    renderRoleCard();
    const n = document.createElement("div");
    n.className = "dead-notice";
    n.textContent = "💀 You have been eliminated. You can keep watching, but you can no longer act.";
    roleDiv.appendChild(n);
});

socket.on("banned", function() {
    alert("You were banned from this room by the host.");
    location.reload();
});

socket.on("timer", function(sec) {
    clearInterval(timerInterval);
    if (!sec) { timerDiv.textContent = ""; return; }
    let left = sec;
    timerDiv.textContent = "⏱️ " + left + "s";
    timerInterval = setInterval(function() {
        left--;
        timerDiv.textContent = left > 0 ? "⏱️ " + left + "s" : "";
        if (left <= 0) clearInterval(timerInterval);
    }, 1000);
});

socket.on("gameEnded", function(d) {
    amDead = false;
    setChat(true);
    roleDiv.innerHTML = "";
    const b = document.createElement("div");
    b.className = "end-banner";
    b.textContent = { Mafia: "🔪 MAFIA WINS!", Town: "👤 TOWN WINS!", Alien: "👽 ALIENS WIN!", Nobody: "💀 NOBODY WINS" }[d.winner]
        || (d.winner === "SerialKiller" ? "🔪 " + d.soloWinner + " (Serial Killer) WINS!" : d.winner === "Jester" ? "🃏 " + d.soloWinner + " (Jester) WINS!" : "Game over.");
    roleDiv.appendChild(b);

    const t = document.createElement("div");
    t.className = "reveal-title";
    t.textContent = "Roles revealed";
    roleDiv.appendChild(t);
    d.players.forEach(function(p) {
        const r = document.createElement("div");
        r.className = "reveal-row" + (p.alive ? "" : " dead");
        const a = document.createElement("span"); a.textContent = p.name;
        const c = document.createElement("span"); c.textContent = p.label;
        r.appendChild(a); r.appendChild(c);
        roleDiv.appendChild(r);
    });

    if (hostId === socket.id) { startButton.style.display = "inline-block"; startButton.textContent = "Play Again"; }
});

chatInput.addEventListener("input", function() { counter(chatInput, chatCounter); });
chatInput.addEventListener("keydown", function(e) { if (e.key === "Enter") sendChat(); });
mafiaInput.addEventListener("input", function() { counter(mafiaInput, mafiaCounter); });
mafiaInput.addEventListener("keydown", function(e) { if (e.key === "Enter") sendMafiaChat(); });
