const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const fetch = require("node-fetch");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

let waiting = [];
let sessions = new Map();
let admins = new Set(); // Admin WS connections
let monitoredSessions = new Map(); // sessionId => admin WS

// Get country from IP using free API
async function getCountry(ip) {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,countryCode`);
    const data = await res.json();
    if (data.status === 'success') return data.countryCode.toLowerCase();
  } catch (e) {}
  return 'unknown';
}

// Matching logic: male-female, lesbian-lesbian, any flexible
function matchUser(user) {
  const index = waiting.findIndex(w => {
    if (user.mode !== w.mode) return false;
    if (user.pref === 'lesbian' && w.pref === 'lesbian') return true;
    if (user.pref === 'male' && (w.pref === 'female' || w.pref === 'any')) return true;
    if (user.pref === 'female' && (w.pref === 'male' || w.pref === 'any')) return true;
    if (user.pref === 'any' && (w.pref === 'male' || w.pref === 'female' || w.pref === 'any')) return true;
    return false;
  });

  if (index !== -1) {
    const partner = waiting.splice(index, 1)[0];
    const sessionId = Date.now().toString();

    sessions.set(user.ws, { partner: partner.ws, sessionId, mode: user.mode });
    sessions.set(partner.ws, { partner: user.ws, sessionId, mode: user.mode });

    user.ws.send(JSON.stringify({ type: "matched", partnerCountry: partner.country }));
    partner.ws.send(JSON.stringify({ type: "matched", partnerCountry: user.country }));

    // Notify admins
    admins.forEach(admin => admin.send(JSON.stringify({ type: 'update_list', list: getActiveList() })));
  } else {
    waiting.push(user);
    admins.forEach(admin => admin.send(JSON.stringify({ type: 'update_list', list: getActiveList() })));
  }
}

// Get active sessions list for admin
function getActiveList() {
  const list = [];
  waiting.forEach(u => list.push({ id: u.ws.id, mode: u.mode, pref: u.pref, country: u.country, status: 'waiting' }));
  sessions.forEach((s, ws) => {
    if (!list.find(l => l.id === ws.id)) {
      list.push({ id: ws.id, mode: s.mode, pref: ws.pref, country: ws.country, status: 'matched', sessionId: s.sessionId });
    }
  });
  return list;
}

wss.on("connection", async (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.connection.remoteAddress;
  const country = await getCountry(ip);
  ws.id = Date.now(); // Unique ID
  ws.country = country;

  ws.on("message", message => {
    try {
      const data = JSON.parse(message);

      if (data.type === "join") {
        ws.mode = data.mode;
        ws.pref = data.pref;
        matchUser({ ws, mode: data.mode, pref: data.pref, country });
      }

      if (data.type === "signal") {
        const sess = sessions.get(ws);
        if (sess) sess.partner.send(JSON.stringify({ type: "signal", signal: data.signal }));
      }

      if (data.type === "chat") {
        const sess = sessions.get(ws);
        if (sess) {
          sess.partner.send(JSON.stringify({ type: "chat", msg: data.msg }));
          // Forward to monitoring admin
          const admin = monitoredSessions.get(sess.sessionId);
          if (admin) admin.send(JSON.stringify({ type: "monitor_chat", sessionId: sess.sessionId, from: 'user', msg: data.msg }));
        }
      }

      if (data.type === "request_video") {
        const sess = sessions.get(ws);
        if (sess) sess.partner.send(JSON.stringify({ type: "request_video" }));
      }

      if (data.type === "accept_video") {
        const sess = sessions.get(ws);
        if (sess) {
          sess.partner.send(JSON.stringify({ type: "start_video" }));
          sess.mode = 'video'; // Upgrade mode
          ws.send(JSON.stringify({ type: "start_video" }));
          admins.forEach(admin => admin.send(JSON.stringify({ type: 'update_list', list: getActiveList() })));
        }
      }

      // Admin commands
      if (data.type === "admin_login") {
        if (data.pass === "admin123") { // Change this password!
          admins.add(ws);
          ws.send(JSON.stringify({ type: 'logged_in', list: getActiveList() }));
        } else {
          ws.send(JSON.stringify({ type: 'error', msg: 'Wrong password' }));
        }
      }

      if (data.type === "monitor") {
        monitoredSessions.set(data.sessionId, ws);
        ws.send(JSON.stringify({ type: 'monitoring', sessionId: data.sessionId }));
      }

      if (data.type === "stop_monitor") {
        monitoredSessions.delete(data.sessionId);
      }
    } catch (e) {}
  });

  ws.on("close", () => {
    const sess = sessions.get(ws);
    if (sess) {
      sess.partner.close();
      sessions.delete(sess.partner);
      monitoredSessions.delete(sess.sessionId);
    }
    sessions.delete(ws);
    waiting = waiting.filter(u => u.ws !== ws);
    admins.delete(ws);
    admins.forEach(admin => admin.send(JSON.stringify({ type: 'update_list', list: getActiveList() })));
  });
});

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
