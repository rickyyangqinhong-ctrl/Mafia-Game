const socket = io();

let myRole = null;
let currentHostId = null;

const MAX_CHAT_LEN = 240;

const menu = document.getElementById("menu");
const lobby = document.getElementById("lobby");
const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const roomCode = document.getElementById("roomCode");
const playerCount = document.getElementById("playerCount");
const playersDiv = document.getElementById("players");
const chatLog = document.getElementById("chatLog");
const chatInput = document.getElementById("chatInput");
const chatCounter = document.getElementById("chatCounter");
const roleDiv = document.getElementById("role");
const startButton = document.getElementById("startButton");

function showLobby(code) {
    menu.style.display = "none";
    lobby.style.display = "block";
    roomCode.textContent = code;
    roleDiv.innerHTML = "";
    chatInput.disabled = false;
    chatInput.placeholder = "Type a message...";
    startButton.style.display = "none";
}

function createRoom() {
    const name = nameInput.value.trim();
    if (!name) { alert("Enter your name."); return; }
    socket.emit("createRoom", name);
}

function joinRoom() {
    const name = nameInput.value.trim();
    const code = roomInput.value.trim().toUpperCase();
    if (!name) { alert("Enter your name."); return; }
    if (!code) { alert("Enter a room code."); return; }
    socket.emit("joinRoom", { code: code, name: name });
}

function startGame() { socket.emit("startGame"); }

function sendChat() {
    const text = chatInput.value.trim();
    if (!text || chatInput.disabled) return;
    socket.emit("chat", text.slice(0, MAX_CHAT_LEN));
    chatInput.value = "";
    updateChatCounter();
}

function updateChatCounter() {
    if (!chatCounter) return;
    chatCounter.textContent = chatInput.value.length + " / " + MAX_CHAT_LEN;
}

function addMessage(message, className) {
    const div = document.createElement("div");
    div.className = className || "chat-system";
    div.textContent = message;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
}

function addChat(name, text) {
    const div = document.createElement("div");
    div.textContent = name + ": " + text;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
}

function clearActionArea() { roleDiv.innerHTML = ""; }

function factionClass(faction) {
    if (faction === "Mafia") return "faction-mafia";
    if (faction === "Innocent") return "faction-innocent";
    return "faction-neutral";
}

function renderRoleCard() {
    if (!myRole) return;
    const card = document.createElement("div");
    card.className = "role-card " + factionClass(myRole.faction);

    const name = document.createElement("div");
    name.className = "role-name";
    name.textContent = myRole.label;

    const faction = document.createElement("div");
    faction.className = "role-faction";
    faction.textContent = myRole.faction + " faction";

    const desc = document.createElement("div");
    desc.className = "role-desc";
    desc.textContent = myRole.description;

    card.appendChild(name); card.appendChild(faction); card.appendChild(desc);
    roleDiv.appendChild(card);
}

function showWaiting(text) {
    clearActionArea();
    renderRoleCard();
    const m = document.createElement("div");
    m.className = "waiting-text";
    m.textContent = text;
    roleDiv.appendChild(m);
}

function showRole() { clearActionArea(); renderRoleCard(); }

function renderButtonList(title, options, onPick) {
    clearActionArea();
    renderRoleCard();
    const t = document.createElement("div");
    t.className = "action-title";
    t.textContent = title;
    roleDiv.appendChild(t);
    options.forEach(function(opt) {
        const btn = document.createElement("button");
        btn.className = "action-btn";
        btn.textContent = opt;
        btn.onclick = function() { onPick(opt); };
        roleDiv.appendChild(btn);
    });
}

socket.on("roomCreated", function(code) { showLobby(code); });
socket.on("joinedRoom", function(code) { showLobby(code); });

socket.on("players", function(players) {
    playersDiv.innerHTML = "";
    players.forEach(function(p) {
        const div = document.createElement("div");
        div.className = "player-row" + (p.alive ? "" : " dead");
        div.textContent = (p.alive ? "🟢 " : "💀 ") + p.name;
        playersDiv.appendChild(div);
    });
    const suffix = players.length === 1 ? "player" : "players";
    playerCount.textContent = players.length + " " + suffix;
});

socket.on("host", function(hostId) {
    currentHostId = hostId;
    if (hostId === socket.id) {
        startButton.style.display = "inline-block";
        startButton.disabled = false;
        startButton.textContent = "Start Game";
    } else {
        startButton.style.display = "none";
    }
});

socket.on("gameStarted", function() { startButton.style.display = "none"; });

socket.on("role", function(role) { myRole = role; showRole(); });

socket.on("gameReset", function() {
    chatInput.disabled = true;
    chatInput.placeholder = "Chat is disabled at night 🌙";
    showRole();
});

socket.on("message", function(message) {
    addMessage(message);
    if (message.indexOf("NIGHT") !== -1) {
        chatInput.disabled = true;
        chatInput.placeholder = "Chat is disabled at night 🌙";
    }
    if (message.indexOf("DAY") !== -1) {
        chatInput.disabled = false;
        chatInput.placeholder = "Type a message...";
    }
});

socket.on("chat", function(data) { addChat(data.name, data.text); });
socket.on("errorMessage", function(message) { alert(message); });

// Generic night action prompt (kill/sabotage/camera/track/visit/heal/guard/investigate)
socket.on("nightAction", function(data) {
    renderButtonList(data.title, data.players, function(pick) {
        showWaiting("⏳ Waiting for the night to finish...");
        socket.emit("nightAction", { type: data.type, target: pick });
    });
});

socket.on("investigateResult", function(data) {
    addMessage(data.result, "chat-clue");
});

// Day: choose Vote or Investigate
socket.on("dayChoice", function() {
    clearActionArea();
    renderRoleCard();
    const t = document.createElement("div");
    t.className = "action-title";
    t.textContent = "🌞 What will you do today?";
    roleDiv.appendChild(t);

    const voteBtn = document.createElement("button");
    voteBtn.className = "action-btn";
    voteBtn.textContent = "🗳️ Vote";
    voteBtn.onclick = function() { socket.emit("dayChoice", { choice: "vote" }); };

    const investigateBtn = document.createElement("button");
    investigateBtn.className = "action-btn";
    investigateBtn.textContent = "🔍 Investigate a location";
    investigateBtn.onclick = function() { socket.emit("dayChoice", { choice: "investigate" }); };

    roleDiv.appendChild(voteBtn);
    roleDiv.appendChild(investigateBtn);
});

socket.on("locationOptions", function(data) {
    renderButtonList(data.title, data.locations, function(pick) {
        showWaiting("⏳ Waiting for everyone to finish...");
        socket.emit("investigateChoice", pick);
    });
});

socket.on("voteOptions", function(data) {
    renderButtonList("🌞 Vote for someone to eliminate:", data.players, function(pick) {
        showWaiting("⏳ Vote submitted. Waiting for everyone...");
        socket.emit("vote", pick);
    });
});

socket.on("waiting", function(message) { showWaiting(message); });

socket.on("gameEnded", function(data) {
    clearActionArea();
    chatInput.disabled = false;
    chatInput.placeholder = "Game ended. Chat is open.";

    const banner = document.createElement("div");
    banner.className = "end-banner";
    if (data.winner === "Mafia") banner.textContent = "🔪 MAFIA WINS!";
    else if (data.winner === "Town") banner.textContent = "👤 TOWN WINS!";
    else if (data.winner === "SerialKiller") banner.textContent = "🔪 " + data.soloWinner + " (Serial Killer) WINS!";
    else if (data.winner === "Jester") banner.textContent = "🃏 " + data.soloWinner + " (Jester) WINS!";
    else banner.textContent = "Game over.";
    roleDiv.appendChild(banner);

    const revealTitle = document.createElement("div");
    revealTitle.className = "reveal-title";
    revealTitle.textContent = "Roles revealed";
    roleDiv.appendChild(revealTitle);

    data.players.forEach(function(p) {
        const row = document.createElement("div");
        row.className = "reveal-row" + (p.alive ? "" : " dead");
        const left = document.createElement("span"); left.textContent = p.name;
        const right = document.createElement("span"); right.textContent = p.label;
        row.appendChild(left); row.appendChild(right);
        roleDiv.appendChild(row);
    });

    if (socket.id === currentHostId) {
        startButton.style.display = "inline-block";
        startButton.disabled = false;
        startButton.textContent = "Play Again";
    } else {
        startButton.style.display = "none";
    }
});

chatInput.addEventListener("input", updateChatCounter);
chatInput.addEventListener("keydown", function(e) { if (e.key === "Enter") sendChat(); });
updateChatCounter();
