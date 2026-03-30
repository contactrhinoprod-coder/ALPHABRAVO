/* ═══════════════════════════════════════════════════════════
   AIRSOFT TRACKER — app.js v3.4
   Bouton rotation + clic joueur recentre carte
═══════════════════════════════════════════════════════════ */

'use strict';

// ══════════════════════════════════════════════════════════
//  FIREBASE — Config
// ══════════════════════════════════════════════════════════
const firebaseConfig = {
  apiKey:            "AIzaSyDu0oZgJtHh_D4GVK03MDSn8hZ5PLl7knE",
  authDomain:        "alphabravo-45d10.firebaseapp.com",
  projectId:         "alphabravo-45d10",
  storageBucket:     "alphabravo-45d10.firebasestorage.app",
  messagingSenderId: "937873962977",
  appId:             "1:937873962977:web:325c8e34162342e71944a0",
};

firebase.initializeApp(firebaseConfig);
const db   = firebase.firestore();
const auth = firebase.auth();

// ── État global ────────────────────────────────────────────
const STATE = {
  pseudo:     '',
  gameCode:   '',
  status:     'in_game',
  myPosition: null,
  uid:        null,
  watchId:    null,
};

// ── Listeners Firestore ─────────────────────────────────────
let unsubPlayers = null;
let unsubPings   = null;

// ── Références carte ────────────────────────────────────────
let map            = null;
let markers        = {};
let pingMarkers    = {};
let myMarker       = null;
let pingTempPos    = null;
let pingModeActive = false;
let _toastTimer    = null;
let mapHeading     = 0; // angle rotation carte en degrés

// ── Dernières positions connues des joueurs ─────────────────
let playerPositions = {}; // { uid: { lat, lng, name } }

// ══════════════════════════════════════════════════════════
//  SÉCURITÉ
// ══════════════════════════════════════════════════════════
function _esc(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}

function _escSvg(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _sanitizePseudo(str) {
  return str.replace(/[^a-zA-Z0-9\-_\u00C0-\u024F]/g, '').substring(0, 12).toUpperCase();
}

// ══════════════════════════════════════════════════════════
//  GOOGLE MAPS
// ══════════════════════════════════════════════════════════
window.initMap = function () {
  map = new google.maps.Map(document.getElementById('map'), {
    center:           { lat: 43.7458, lng: 7.1947 },
    zoom:             16,
    mapTypeId:        'satellite',
    disableDefaultUI: true,
    gestureHandling:  'greedy',
    heading:          0,
    tilt:             0,
  });

  map.addListener('click', (e) => {
    if (pingModeActive && e.latLng) {
      _openPingDialog(e.latLng);
      _setPingMode(false);
    }
  });
};

// ══════════════════════════════════════════════════════════
//  ROTATION CARTE
// ══════════════════════════════════════════════════════════
function _rotateMap() {
  if (!map) return;
  mapHeading = (mapHeading + 45) % 360;
  map.setHeading(mapHeading);

  // Met à jour l'icône du bouton pour indiquer l'angle
  const btn = document.getElementById('btn-rotate');
  if (btn) {
    const arrow = btn.querySelector('svg');
    if (arrow) arrow.style.transform = `rotate(${mapHeading}deg)`;
  }

  if (mapHeading === 0) {
    _toast('Nord ↑', 1000);
  }
}

// ══════════════════════════════════════════════════════════
//  MODE PING
// ══════════════════════════════════════════════════════════
function _setPingMode(active) {
  pingModeActive = active;
  const btn    = document.getElementById('btn-ping-mode');
  const mapDiv = document.getElementById('map');
  if (active) {
    btn.classList.add('active');
    btn.style.borderColor = '#f39c12';
    btn.style.color       = '#f39c12';
    if (mapDiv) mapDiv.style.cursor = 'crosshair';
    _toast('Tape sur la carte pour poser un ping', 3500);
  } else {
    btn.classList.remove('active');
    btn.style.borderColor = '';
    btn.style.color       = '';
    if (mapDiv) mapDiv.style.cursor = '';
  }
}

// ══════════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════════
function _showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function _showMap() {
  _showScreen('screen-map');
  document.getElementById('panel-code').textContent = STATE.gameCode;
  _startGPS();
  _subscribeToPlayers();
  _subscribeToPings();
}

// ══════════════════════════════════════════════════════════
//  GPS
// ══════════════════════════════════════════════════════════
function _startGPS() {
  if (!navigator.geolocation) { _toast('GPS non disponible'); return; }
  if (STATE.watchId !== null) _stopGPS();

  STATE.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lng, heading } = pos.coords;
      STATE.myPosition = { lat, lng, heading: heading || 0 };
      _updateMyMarker(lat, lng);
      _firestoreUpdatePosition(lat, lng);
    },
    (err) => {
      const msgs = { 1: 'Permission GPS refusée', 2: 'Position indisponible', 3: 'Timeout GPS' };
      _toast(msgs[err.code] || 'Erreur GPS');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

function _stopGPS() {
  if (STATE.watchId !== null) {
    navigator.geolocation.clearWatch(STATE.watchId);
    STATE.watchId = null;
  }
}

// ══════════════════════════════════════════════════════════
//  FIRESTORE
// ══════════════════════════════════════════════════════════
function _playersRef() {
  return db.collection('games').doc(STATE.gameCode).collection('players');
}

function _pingsRef() {
  return db.collection('games').doc(STATE.gameCode).collection('pings');
}

function _firestoreJoinGame() {
  return _playersRef().doc(STATE.uid).set({
    name:      STATE.pseudo,
    status:    'in_game',
    lat:       0,
    lng:       0,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

function _firestoreUpdatePosition(lat, lng) {
  if (!STATE.uid || !STATE.gameCode) return;
  _playersRef().doc(STATE.uid).update({
    lat,
    lng,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});
}

function _firestoreUpdateStatus(status) {
  if (!STATE.uid || !STATE.gameCode) return;
  _playersRef().doc(STATE.uid).update({ status }).catch(() => {});
}

function _firestoreLeaveGame() {
  if (!STATE.uid || !STATE.gameCode) return Promise.resolve();
  return _playersRef().doc(STATE.uid).delete().catch(() => {});
}

function _subscribeToPlayers() {
  if (unsubPlayers) unsubPlayers();
  unsubPlayers = _playersRef().onSnapshot((snapshot) => {
    Object.values(markers).forEach(m => m.setMap(null));
    markers = {};
    playerPositions = {};
    const teamList = {};

    snapshot.forEach((doc) => {
      const player = doc.data();
      const uid    = doc.id;
      teamList[uid] = player;

      // Stocke la position pour le clic dans le panneau
      if (player.lat && player.lng && player.lat !== 0) {
        playerPositions[uid] = { lat: player.lat, lng: player.lng, name: player.name };
      }

      if (uid === STATE.uid) return;
      if (!player.lat || !player.lng || player.lat === 0) return;

      const updatedAt = player.updatedAt ? player.updatedAt.toMillis() : 0;
      const isOffline = Date.now() - updatedAt > 60000;
      const color     = isOffline ? '#555e55'
        : player.status === 'in_game' ? '#3498db' : '#e74c3c';

      if (map) {
        markers[uid] = new google.maps.Marker({
          position: { lat: player.lat, lng: player.lng },
          map,
          icon:  _markerIcon(color, player.name),
          title: player.name,
        });
      }
    });

    _renderTeamPanel(teamList);
  }, (err) => {
    console.error('Firestore players error:', err);
    _toast('Erreur Firestore: ' + err.message);
  });
}

function _subscribeToPings() {
  if (unsubPings) unsubPings();
  unsubPings = _pingsRef().onSnapshot((snapshot) => {
    const firestoreIds = new Set(snapshot.docs.map(d => d.id));

    Object.keys(pingMarkers).forEach((id) => {
      if (!firestoreIds.has(id)) {
        pingMarkers[id].infoWindow.close();
        pingMarkers[id].marker.setMap(null);
        delete pingMarkers[id];
      }
    });

    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        const ping = change.doc.data();
        const id   = change.doc.id;
        if (!pingMarkers[id]) {
          _renderPingMarker(id, {
            lat:        ping.lat,
            lng:        ping.lng,
            playerName: ping.playerName,
            comment:    ping.comment || '',
          });
        }
      }
      if (change.type === 'removed') {
        _removePingMarker(change.doc.id);
      }
    });
  }, (err) => {
    console.error('Firestore pings error:', err);
  });
}

// ══════════════════════════════════════════════════════════
//  MARQUEURS
// ══════════════════════════════════════════════════════════
function _updateMyMarker(lat, lng) {
  if (!map || lat == null || lng == null || isNaN(lat) || isNaN(lng)) return;
  const pos   = { lat, lng };
  const color = STATE.status === 'in_game' ? '#2ecc71' : '#e74c3c';
  const icon  = _markerIcon(color, STATE.pseudo);
  if (!myMarker) {
    myMarker = new google.maps.Marker({ position: pos, map, icon, zIndex: 999 });
  } else {
    myMarker.setPosition(pos);
    myMarker.setIcon(icon);
  }
  map.panTo(pos);
}

function _markerIcon(color, label) {
  const safeLabel = _escSvg(String(label || '').substring(0, 8));
  const safeColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#888888';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="64" viewBox="0 0 48 64">
    <circle cx="24" cy="22" r="18" fill="${safeColor}" stroke="rgba(0,0,0,0.35)" stroke-width="2"/>
    <polygon points="16,36 32,36 24,52" fill="${safeColor}" stroke="rgba(0,0,0,0.35)" stroke-width="1"/>
    <circle cx="24" cy="22" r="7" fill="rgba(255,255,255,0.55)"/>
    <text x="24" y="63" text-anchor="middle" font-family="monospace" font-size="9"
      fill="white" stroke="rgba(0,0,0,0.9)" stroke-width="3" paint-order="stroke">${safeLabel}</text>
  </svg>`;
  return {
    url:        'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(48, 64),
    anchor:     new google.maps.Point(24, 52),
  };
}

// ══════════════════════════════════════════════════════════
//  PINGS — permanents jusqu'à suppression manuelle
// ══════════════════════════════════════════════════════════
function _openPingDialog(latLng) {
  if (!latLng) return;
  pingTempPos = latLng;
  document.getElementById('input-ping-comment').value = '';
  document.getElementById('dialog-ping').classList.remove('hidden');
  setTimeout(() => document.getElementById('input-ping-comment').focus(), 150);
}

function _closePingDialog() {
  document.getElementById('dialog-ping').classList.add('hidden');
  pingTempPos = null;
}

function _addPing(comment) {
  if (!pingTempPos) return;
  const safeComment = _esc(String(comment || '').substring(0, 60));
  const id = Date.now().toString();

  _pingsRef().doc(id).set({
    lat:        pingTempPos.lat(),
    lng:        pingTempPos.lng(),
    playerName: STATE.pseudo,
    comment:    safeComment,
    createdAt:  firebase.firestore.FieldValue.serverTimestamp(),
  });

  _closePingDialog();
  _toast('Ping posé' + (comment ? ' — ' + comment.substring(0, 20) : ''));
}

function _renderPingMarker(id, ping) {
  if (!map) return;

  const content = document.createElement('div');
  content.style.cssText = 'font-family:monospace;font-size:12px;color:#222;padding:4px;max-width:200px';

  const title = document.createElement('b');
  title.textContent = '📍 ' + ping.playerName;
  content.appendChild(title);

  if (ping.comment) {
    content.appendChild(document.createElement('br'));
    const txt = document.createElement('span');
    txt.textContent = ping.comment;
    content.appendChild(txt);
  }

  content.appendChild(document.createElement('br'));
  const del = document.createElement('span');
  del.textContent   = '✕ Supprimer';
  del.style.cssText = 'color:#e74c3c;font-size:11px;cursor:pointer;font-weight:bold';
  del.addEventListener('click', () => _pingsRef().doc(id).delete().catch(() => {}));
  content.appendChild(del);

  const infoWindow = new google.maps.InfoWindow({ content });
  const marker = new google.maps.Marker({
    position: { lat: ping.lat, lng: ping.lng },
    map,
    icon:   _pingIcon(),
    title:  ping.playerName + (ping.comment ? ' — ' + ping.comment : ''),
    zIndex: 500,
  });
  marker.addListener('click', () => infoWindow.open({ map, anchor: marker }));
  pingMarkers[id] = { marker, infoWindow };
}

function _removePingMarker(id) {
  if (pingMarkers[id]) {
    pingMarkers[id].infoWindow.close();
    pingMarkers[id].marker.setMap(null);
    delete pingMarkers[id];
  }
}

function _pingIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="48" viewBox="0 0 36 48">
    <circle cx="18" cy="16" r="14" fill="#f39c12" stroke="rgba(0,0,0,0.35)" stroke-width="2"/>
    <polygon points="10,26 26,26 18,40" fill="#f39c12" stroke="rgba(0,0,0,0.35)" stroke-width="1"/>
    <text x="18" y="21" text-anchor="middle" font-family="monospace" font-size="14" fill="white">!</text>
  </svg>`;
  return {
    url:        'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(36, 48),
    anchor:     new google.maps.Point(18, 40),
  };
}

// ══════════════════════════════════════════════════════════
//  ÉQUIPE — clic joueur recentre la carte
// ══════════════════════════════════════════════════════════
function _renderTeamPanel(players) {
  const list = document.getElementById('team-list');
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);

  const uids = Object.keys(players || {});
  if (uids.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:16px;color:var(--text-dim);font-size:11px;text-align:center';
    empty.textContent   = 'Aucun joueur';
    list.appendChild(empty);
    return;
  }

  uids.forEach((uid) => {
    const player    = players[uid];
    const isMe      = uid === STATE.uid;
    const updatedAt = player.updatedAt ? player.updatedAt.toMillis() : 0;
    const isOffline = Date.now() - updatedAt > 60000;
    const hasPos    = player.lat && player.lng && player.lat !== 0;

    const dotClass    = isOffline ? 'offline' : player.status === 'in_game' ? 'online-ingame' : 'online-out';
    const statusClass = isOffline ? 'offline' : player.status === 'in_game' ? 'ingame' : 'out';
    const statusLabel = isOffline ? 'HORS LIGNE' : player.status === 'in_game' ? 'EN JEU' : 'OUT';

    const row = document.createElement('div');
    row.className = 'team-player';
    if (hasPos && !isMe) {
      row.style.cursor = 'pointer';
      row.title        = 'Centrer sur ' + player.name;
      row.addEventListener('click', () => {
        if (map && player.lat && player.lng) {
          map.panTo({ lat: player.lat, lng: player.lng });
          map.setZoom(18);
          // Ferme le panneau pour voir la carte
          document.getElementById('panel-team').classList.add('hidden');
          document.getElementById('btn-team').classList.remove('active');
          _toast('Centré sur ' + player.name, 1500);
        }
      });
    }

    const dot = document.createElement('div');
    dot.className = `team-player-dot ${dotClass}`;

    const info = document.createElement('div');
    info.className = 'team-player-info';

    const name = document.createElement('div');
    name.className   = 'team-player-name' + (isMe ? ' me' : '');
    name.textContent = player.name;

    const status = document.createElement('div');
    status.className   = `team-player-status ${statusClass}`;
    status.textContent = statusLabel + (hasPos && !isMe ? ' ◎' : '');

    info.appendChild(name);
    info.appendChild(status);
    row.appendChild(dot);
    row.appendChild(info);
    list.appendChild(row);
  });
}

// ══════════════════════════════════════════════════════════
//  STATUT
// ══════════════════════════════════════════════════════════
function _toggleStatus() {
  STATE.status = STATE.status === 'in_game' ? 'out' : 'in_game';
  const btn   = document.getElementById('btn-status');
  const label = document.getElementById('status-label');
  btn.className     = 'btn-status ' + (STATE.status === 'in_game' ? 'in-game' : 'out');
  label.textContent = STATE.status === 'in_game' ? 'EN JEU' : 'OUT';
  _firestoreUpdateStatus(STATE.status);
  if (STATE.myPosition) _updateMyMarker(STATE.myPosition.lat, STATE.myPosition.lng);
}

// ══════════════════════════════════════════════════════════
//  PARTIE
// ══════════════════════════════════════════════════════════
async function _createGame() {
  if (!STATE.uid) { _toast('Connexion en cours, réessaie...'); return; }
  const pseudo = _sanitizePseudo(document.getElementById('input-pseudo').value.trim());
  if (!pseudo) { _toast('Entre un pseudo valide !'); return; }

  STATE.pseudo   = pseudo;
  STATE.gameCode = _generateCode();

  try {
    await db.collection('games').doc(STATE.gameCode).set({
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      active:    true,
    });
    await _firestoreJoinGame();
    _showMap();
    _toast('Partie créée — CODE: ' + STATE.gameCode);
  } catch (err) {
    console.error('createGame error:', err);
    _toast('Erreur: ' + err.message);
  }
}

async function _joinGame() {
  if (!STATE.uid) { _toast('Connexion en cours, réessaie...'); return; }
  const pseudo = _sanitizePseudo(document.getElementById('input-pseudo').value.trim());
  const code   = document.getElementById('input-code').value.trim();
  if (!pseudo) { _toast('Entre un pseudo valide !'); return; }
  if (!/^\d{6}$/.test(code)) { _toast('Le code doit être 6 chiffres !'); return; }

  STATE.pseudo   = pseudo;
  STATE.gameCode = code;

  try {
    await _firestoreJoinGame();
    _showMap();
    _toast('Partie rejointe — CODE: ' + STATE.gameCode);
  } catch (err) {
    console.error('joinGame error:', err);
    _toast('Erreur: ' + err.message);
  }
}

async function _leaveGame() {
  _stopGPS();
  _setPingMode(false);

  await _firestoreLeaveGame();

  if (unsubPlayers) { unsubPlayers(); unsubPlayers = null; }
  if (unsubPings)   { unsubPings();   unsubPings   = null; }

  if (myMarker) { myMarker.setMap(null); myMarker = null; }
  Object.values(markers).forEach(m => m.setMap(null));
  markers = {};
  Object.values(pingMarkers).forEach(({ marker, infoWindow }) => {
    infoWindow.close();
    marker.setMap(null);
  });
  pingMarkers    = {};
  playerPositions = {};
  mapHeading     = 0;

  STATE.myPosition = null;
  STATE.status     = 'in_game';
  STATE.gameCode   = '';

  const btn = document.getElementById('btn-status');
  const lbl = document.getElementById('status-label');
  if (btn) btn.className   = 'btn-status in-game';
  if (lbl) lbl.textContent = 'EN JEU';

  document.getElementById('panel-team')?.classList.add('hidden');
  document.getElementById('btn-team')?.classList.remove('active');

  _showScreen('screen-home');
}

// ══════════════════════════════════════════════════════════
//  UTILITAIRES
// ══════════════════════════════════════════════════════════
function _generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function _toast(msg, duration = 2800) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = String(msg).substring(0, 80);
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ══════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {

  const btnCreate = document.getElementById('btn-create');
  const btnJoin   = document.getElementById('btn-join');
  btnCreate.disabled      = true;
  btnJoin.disabled        = true;
  btnCreate.style.opacity = '0.5';
  btnJoin.style.opacity   = '0.5';

  auth.signInAnonymously()
    .then((cred) => {
      STATE.uid               = cred.user.uid;
      btnCreate.disabled      = false;
      btnJoin.disabled        = false;
      btnCreate.style.opacity = '1';
      btnJoin.style.opacity   = '1';
    })
    .catch((err) => {
      console.error('Auth error:', err);
      _toast('Erreur Firebase: ' + err.message);
    });

  btnCreate.addEventListener('click', _createGame);
  btnJoin.addEventListener('click', _joinGame);

  document.getElementById('input-pseudo').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('input-code').focus();
  });
  document.getElementById('input-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') _joinGame();
  });
  document.getElementById('input-code').addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\D/g, '').substring(0, 6);
  });

  document.getElementById('btn-back').addEventListener('click', _leaveGame);
  document.getElementById('btn-status').addEventListener('click', _toggleStatus);

  document.getElementById('btn-satellite').addEventListener('click', () => {
    if (!map) return;
    const isSat = map.getMapTypeId() === 'satellite';
    map.setMapTypeId(isSat ? 'roadmap' : 'satellite');
    document.getElementById('btn-satellite').classList.toggle('active', !isSat);
  });

  document.getElementById('btn-rotate').addEventListener('click', _rotateMap);

  document.getElementById('btn-team').addEventListener('click', () => {
    document.getElementById('panel-team').classList.toggle('hidden');
    document.getElementById('btn-team').classList.toggle('active');
  });

  document.getElementById('btn-close-panel').addEventListener('click', () => {
    document.getElementById('panel-team').classList.add('hidden');
    document.getElementById('btn-team').classList.remove('active');
  });

  document.getElementById('btn-ping-mode').addEventListener('click', () => {
    _setPingMode(!pingModeActive);
  });

  document.getElementById('btn-locate').addEventListener('click', () => {
    if (STATE.myPosition && map) {
      map.panTo({ lat: STATE.myPosition.lat, lng: STATE.myPosition.lng });
      map.setZoom(17);
      // Remet le nord
      mapHeading = 0;
      map.setHeading(0);
    } else {
      _toast('Position GPS non disponible');
    }
  });

  document.getElementById('btn-ping-cancel').addEventListener('click', _closePingDialog);
  document.getElementById('btn-ping-confirm').addEventListener('click', () => {
    _addPing(document.getElementById('input-ping-comment').value.trim());
  });
  document.getElementById('input-ping-comment').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); _addPing(e.target.value.trim()); }
  });
  document.getElementById('dialog-ping').addEventListener('click', (e) => {
    if (e.target === document.getElementById('dialog-ping')) _closePingDialog();
  });
});
