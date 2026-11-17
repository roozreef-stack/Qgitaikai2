'use strict';

const DEFAULT_ARRIVAL_RADIUS = 25;
const LOW_ACCURACY_M = 50;   // これより誤差が大きいと注意を出す
const HEADING_SMOOTHING = 0.15; // 向きのローパスフィルタ係数（小さいほど滑らかで反応は遅い）
const HEADING_WAIT_MS = 3000;   // この時間センサーの値が来なければ「使えません」表示にする
const URGENT_MS = 10 * 60 * 1000; // 残りがこれを切ったら残り時間の色を変える
const STATUS_LABEL = { locked: '未解答', revealed: '場所が判明', cleared: 'クリア' };

const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';

const state = {
  data: null,        // checkpoints.json の内容
  map: null,         // Leaflet地図（地図タブを最初に開いたときに作る）
  markers: {},       // CPのid → Leafletマーカー（場所が判明したCPだけ）
  tab: 'list',       // 表示中のタブ（'list' | 'map'）
  selectedId: null,  // パネルで選択中のCP
  panelKey: null,    // パネルの表示状態（CP＋状態）。変わったら入力欄をリセットする
  position: null,    // 現在地 { lat, lng, accuracy }
  stopWatch: null,   // watchPosition を止める関数
  userMarker: null,  // 現在地の点
  accuracyCircle: null, // 誤差の円
  heading: null,     // 端末の向き（北=0、時計回り）。取得できないときは null
  arrowAngle: 0,     // 矢印の表示角（360をまたいでも逆回りしないよう連続値で持つ）
  useCompass: false, // 向きセンサーを使うか
  compassNeedsTap: false, // iOSでリロード後など、許可にタップが必要な状態
  stopHeading: null, // 向きの監視を止める関数
  headingVec: null,  // 平滑化した向き（単位ベクトル）
  headingWaiting: false, // センサーの最初の値を待っている間 true
  compassFrame: 0,   // 描画予約（requestAnimationFrame）のID
  tickTimer: 0,      // 残り時間更新のタイマー
  ended: false,      // ゲーム終了済み
  debugOffsetMs: 0,  // デバッグ用：現在時刻をずらす量
  dialogOk: null,    // ダイアログの主ボタンを押したときの処理
  // 進捗（localStorage に保存する）
  progress: {
    startedAt: null, // スタート時刻（ms）
    revealed: {},    // CPのid → 謎に正解して場所が判明した時刻（ms）
    cleared: {},     // CPのid → 現地の問題に正解してクリアした時刻（ms）
    goalAt: null,    // 全CPクリアの時刻（ms）
  },
};

const $ = (id) => document.getElementById(id);

// 現在時刻。時間に関する判定はすべてここを通す
// 端末の時計（Date.now）から毎回計算し、タイマーの積算には頼らない
function now() {
  return Date.now() + (DEBUG ? state.debugOffsetMs : 0);
}

// 終了日時。デバッグモードでは ?endAt=... で上書きできる
function endAtMs() {
  if (DEBUG && params.get('endAt')) {
    const t = Date.parse(params.get('endAt'));
    if (!Number.isNaN(t)) return t;
  }
  return Date.parse(state.data.endAt);
}

function isTimeUp() {
  return now() >= endAtMs();
}

// CPの状態：locked（未解答）→ revealed（場所が判明）→ cleared（クリア）
function cpStatus(id) {
  if (state.progress.cleared[id] != null) return 'cleared';
  if (state.progress.revealed[id] != null) return 'revealed';
  return 'locked';
}

function clearedCount() {
  return state.data.checkpoints.filter((cp) => cpStatus(cp.id) === 'cleared').length;
}

function findCheckpoint(id) {
  return state.data.checkpoints.find((cp) => cp.id === id);
}

function selectedCheckpoint() {
  return state.selectedId ? findCheckpoint(state.selectedId) : null;
}

function isArrived(cp) {
  const pos = state.position;
  if (!pos) return false;
  return Geo.distance(pos.lat, pos.lng, cp.lat, cp.lng) <= cp.arrivalRadius;
}

// ---------- 進捗の保存（localStorage） ----------
// キーに終了日時を含め、別の回のイベントで再利用しても古い進捗が混ざらないようにする
function storageKey() {
  return `walkrally:v2:${state.data.endAt}`;
}
const DEBUG_OFFSET_KEY = 'walkrally:debugOffset';

function saveProgress() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(state.progress));
  } catch (err) {
    setStatus('進捗を保存できません。プライベートブラウズをやめるか、ブラウザの設定で保存を許可してください。');
  }
}

function loadProgress() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(storageKey()) || 'null');
  } catch (err) {
    saved = null;
  }
  if (!saved || typeof saved !== 'object') return;
  const ids = new Set(state.data.checkpoints.map((cp) => cp.id));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const { progress } = state;
  progress.startedAt = num(saved.startedAt);
  progress.revealed = {};
  progress.cleared = {};
  // JSONから消えたCPの記録は捨てる
  Object.entries(saved.revealed || {}).forEach(([id, t]) => {
    if (ids.has(id) && num(t) != null) progress.revealed[id] = t;
  });
  Object.entries(saved.cleared || {}).forEach(([id, t]) => {
    if (!ids.has(id) || num(t) == null) return;
    progress.cleared[id] = t;
    if (progress.revealed[id] == null) progress.revealed[id] = t;
  });
  // CPが増えた場合などは全クリア扱いにしない
  progress.goalAt = clearedCount() === state.data.checkpoints.length ? num(saved.goalAt) : null;
}

function resetProgress() {
  if (!window.confirm('進捗をすべて消して、最初からやり直します。よろしいですか？')) return;
  try {
    localStorage.removeItem(storageKey());
    sessionStorage.removeItem(DEBUG_OFFSET_KEY);
  } catch (err) { /* 保存できない環境では消すものもない */ }
  location.reload();
}

// ---------- 答えの照合 ----------
// 全角半角（NFKC）・大文字小文字・前後の空白を無視し、カタカナはひらがなに揃える
function normalizeAnswer(text) {
  return String(text).normalize('NFKC').trim().toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

function matchesAnswer(input, answers) {
  const n = normalizeAnswer(input);
  if (n === '') return false;
  return answers.some((a) => normalizeAnswer(a) === n);
}

// ---------- 表示用の整形 ----------
const pad2 = (n) => String(n).padStart(2, '0');

// 残り時間 hh:mm:ss（24時間以上あるときは「n日 hh:mm:ss」）
function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(total / 86400);
  const hms = `${pad2(Math.floor((total % 86400) / 3600))}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`;
  return d > 0 ? `${d}日 ${hms}` : hms;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h > 0 ? `${h}時間${m}分${sec}秒` : `${m}分${sec}秒`;
}

// 結果画面用の短い日時（例：10/31(土) 16:00）
function formatShortDateTime(ms) {
  return new Date(ms).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatDateTime(date) {
  if (typeof date === 'number') date = new Date(date);
  return date.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
}

// ---------- データ読み込み ----------
// 答えは文字列でも配列でもよい。空の候補は捨てる
function toAnswers(value) {
  return [].concat(value == null ? [] : value)
    .filter((v) => typeof v === 'string' && v.trim() !== '');
}

async function loadData() {
  let res;
  try {
    res = await fetch('data/checkpoints.json', { cache: 'no-store' });
  } catch (err) {
    throw new Error('checkpoints.json を読み込めませんでした。通信を確認して、ページを再読み込みしてください。');
  }
  if (!res.ok) throw new Error(`checkpoints.json の読み込みに失敗しました（HTTP ${res.status}）。ページを再読み込みしてください。`);
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error('checkpoints.json の書式が正しくありません（JSONとして読めません）。カンマや引用符の抜けがないか確認してください。');
  }
  if (!Array.isArray(data.checkpoints) || data.checkpoints.length === 0) {
    throw new Error('checkpoints.json にチェックポイントがありません。');
  }
  const seen = new Set();
  data.checkpoints.forEach((cp, i) => {
    const label = `checkpoints の ${i + 1} 件目（id: ${cp.id}）`;
    if (typeof cp.id !== 'string' || cp.id === '') throw new Error(`checkpoints の ${i + 1} 件目に id がありません。`);
    if (seen.has(cp.id)) throw new Error(`${label} の id が重複しています。`);
    seen.add(cp.id);
    if (!Number.isFinite(cp.lat) || !Number.isFinite(cp.lng)) throw new Error(`${label} の lat / lng が数値ではありません。`);
    cp.answer = toAnswers(cp.answer);
    cp.siteAnswer = toAnswers(cp.siteAnswer);
    if (cp.answer.length === 0) throw new Error(`${label} の answer（謎の答え）がありません。`);
    if (cp.siteAnswer.length === 0) throw new Error(`${label} の siteAnswer（現地の答え）がありません。`);
    if (!cp.puzzle) throw new Error(`${label} の puzzle（謎）がありません。`);
    if (!cp.siteQuestion) throw new Error(`${label} の siteQuestion（現地の問題）がありません。`);
    if (!cp.name) cp.name = cp.id;
    if (cp.arrivalRadius == null) cp.arrivalRadius = DEFAULT_ARRIVAL_RADIUS;
  });
  return data;
}

// ---------- 画面切り替え ----------
function showScreen(name) {
  ['start', 'main', 'end'].forEach((s) => {
    $(`screen-${s}`).hidden = s !== name;
  });
}

// ---------- スタート画面 ----------
function renderStart() {
  const { data } = state;
  document.title = data.gameTitle || document.title;
  $('start-title').textContent = data.gameTitle || '謎解きウォークラリー';
  $('start-count').textContent = data.checkpoints.length;
  $('start-endat').textContent = formatDateTime(endAtMs());
  $('start-debug').hidden = !DEBUG;
  showScreen('start');
}

function showStartError(lines) {
  const box = $('start-error');
  box.replaceChildren(...lines.map((line) => {
    const p = document.createElement('p');
    p.style.margin = '0';
    p.textContent = line;
    return p;
  }));
  box.hidden = false;
}

// useCompass=false は「コンパスなしで始める」を押したとき
async function onStart(useCompass = true) {
  const btn = $('btn-start');
  $('start-error').hidden = true;
  $('btn-start-nocompass').hidden = true;

  // デバッグモードでは位置情報・センサーを使わず、地図のタップとスライダーで指定する
  if (DEBUG) {
    enterMain();
    return;
  }

  if (!window.isSecureContext) {
    showStartError(['位置情報はHTTPSで開いたページでしか使えません。https:// で始まるURLから開き直してください。']);
    return;
  }
  if (!Geo.isSupported()) {
    showStartError(['このブラウザは位置情報に対応していません。iPhoneはSafari、AndroidはChromeで開いてください。']);
    return;
  }

  // iOSの向きセンサー許可はタップ操作の中でしか求められないため、await より前に呼ぶ
  const orientationRequest = useCompass ? Geo.requestOrientationPermission() : Promise.resolve('skipped');

  btn.disabled = true;
  btn.textContent = '許可を確認中…';
  let pos = null;
  let posError = null;
  try {
    pos = await Geo.getCurrentPosition();
  } catch (err) {
    posError = err;
  }
  const orientation = await orientationRequest;
  btn.disabled = false;
  btn.textContent = 'もう一度試す';

  if (posError && posError.code === 1) {
    // 位置情報が拒否された：ゲームが成り立たないので先へ進めない
    showStartError([
      '位置情報の利用が許可されていないため、ゲームを始められません。現在地とチェックポイントの距離で到着を判定するためです。',
      'iPhone：設定 → プライバシーとセキュリティ → 位置情報サービス をオンにし、「Safari」を「使用中のみ許可」にしてください。',
      'Android：Chromeのアドレスバー左のアイコン → 権限 → 位置情報 を「許可」にしてください。',
      '設定を変えたら、下のボタンをもう一度押してください。',
    ]);
    return;
  }

  if (orientation === 'denied') {
    // 向きセンサーが拒否された：再試行するか、コンパスなしで進むかを選べる
    showStartError([
      '端末の向きの利用が許可されていないため、コンパス（目的地の方向を指す矢印）が使えません。',
      'iPhone：Safariを完全に閉じて開き直し、もう一度試すと許可の確認が出ます。出ない場合は 設定 → アプリ → Safari → 詳細 → Webサイトデータ から、このサイトのデータを削除してください。',
      'Android：Chromeのアドレスバー左のアイコン → 権限 → モーションセンサー を「許可」にしてください。',
      'コンパスがなくても、目的地までの残り距離を頼りに遊べます。',
    ]);
    $('btn-start-nocompass').hidden = false;
    return;
  }

  state.useCompass = orientation === 'granted';
  enterMain();
  // タイムアウトなど一時的なエラーはメイン画面で取得を続ける
  if (pos) onPosition(pos);
  else onPositionError(posError);
}

// ---------- メイン画面（謎の一覧／地図） ----------
function enterMain() {
  // スタート画面を開いたまま終了日時を過ぎた場合
  if (isTimeUp()) {
    endGame();
    return;
  }
  if (state.progress.startedAt == null) {
    state.progress.startedAt = now();
    saveProgress();
  }
  showScreen('main');
  startTicker();
  refreshAll();
  showTab(state.tab);
  if (DEBUG) {
    $('debug-bar').hidden = false;
    setHeading(Number($('debug-heading').value));
  } else {
    if (!state.stopWatch) state.stopWatch = Geo.watchPosition(onPosition, onPositionError);
    if (state.useCompass && !state.stopHeading) startHeading();
  }
}

// 進捗が変わったときに、ヘッダー・一覧・ピンをまとめて更新する
function refreshAll() {
  updateHeader();
  renderList();
  syncMarkers();
}

function updateHeader() {
  const total = state.data.checkpoints.length;
  $('clear-count').textContent = `${clearedCount()} / ${total}`;
}

function showTab(name) {
  state.tab = name;
  $('view-list').hidden = name !== 'list';
  $('view-map').hidden = name !== 'map';
  [['list', 'tab-list'], ['map', 'tab-map']].forEach(([key, id]) => {
    const active = key === name;
    $(id).setAttribute('aria-selected', String(active));
    $(id).classList.toggle('is-active', active);
  });
  if (name === 'map') {
    // 非表示のあいだは地図の大きさが0なので、見えるようにしてから作る・測り直す
    ensureMap();
    state.map.invalidateSize();
  } else {
    renderList();
  }
}

// ---------- 謎の一覧 ----------
function renderList() {
  $('cp-list').replaceChildren(...state.data.checkpoints.map((cp) => {
    const status = cpStatus(cp.id);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cp-item is-${status}`;
    if (cp.id === state.selectedId) btn.classList.add('is-selected');
    const name = document.createElement('span');
    name.className = 'cp-item-name';
    name.textContent = cp.name;
    const label = document.createElement('span');
    label.className = 'cp-item-status';
    label.textContent = STATUS_LABEL[status];
    btn.append(name, label);
    btn.addEventListener('click', () => selectCheckpoint(cp.id));
    li.append(btn);
    return li;
  }));
}

// ---------- 地図 ----------
function ensureMap() {
  if (state.map) return;
  const { data } = state;
  const map = L.map('map', { zoomControl: true, attributionControl: true });
  state.map = map;

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  if (DEBUG) {
    map.on('click', (e) => {
      setPosition({ lat: e.latlng.lat, lng: e.latlng.lng, accuracy: 0 });
    });
  }

  const c = data.mapCenter || {};
  if (c.lat != null && c.lng != null) map.setView([c.lat, c.lng], c.zoom || 17);
  syncMarkers();
  if (state.position) renderPosition();
  fitPins();
}

// 場所が判明した（revealed / cleared）CPのピンだけを置く。未解答のCPは出さない
function syncMarkers() {
  if (!state.map) return;
  state.data.checkpoints.forEach((cp) => {
    const status = cpStatus(cp.id);
    const marker = state.markers[cp.id];
    if (status === 'locked') {
      if (marker) {
        marker.remove();
        delete state.markers[cp.id];
      }
      return;
    }
    if (marker) {
      marker.setIcon(pinIcon(cp));
      return;
    }
    const m = L.marker([cp.lat, cp.lng], {
      icon: pinIcon(cp),
      title: cp.name,
      keyboard: true,
    }).addTo(state.map);
    m.on('click', () => selectCheckpoint(cp.id));
    state.markers[cp.id] = m;
  });
  $('map-empty').hidden = Object.keys(state.markers).length > 0;
}

function pinIcon(cp) {
  const classes = ['cp-pin'];
  if (cpStatus(cp.id) === 'cleared') classes.push('is-cleared');
  if (cp.id === state.selectedId) classes.push('is-selected');
  const el = document.createElement('div');
  el.className = 'cp-pin-body';
  el.textContent = cp.name;
  return L.divIcon({
    className: classes.join(' '),
    html: el.outerHTML,
    iconSize: [48, 40],
    iconAnchor: [24, 20],
  });
}

// 表示中のピンが収まる範囲に合わせる。ピンがなければ mapCenter に戻す
function fitPins() {
  if (!state.map) return;
  const points = Object.values(state.markers).map((m) => m.getLatLng());
  if (points.length === 0) {
    const c = state.data.mapCenter || {};
    if (c.lat != null && c.lng != null) state.map.setView([c.lat, c.lng], c.zoom || 17);
  } else if (points.length === 1) {
    state.map.setView(points[0], 18);
  } else {
    state.map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 18 });
  }
}

// ---------- 現在地 ----------
function onPosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  setPosition({ lat: latitude, lng: longitude, accuracy });
}

function onPositionError(err) {
  // すでに位置が取れていて一時的なタイムアウトなら、表示中の位置を使い続ける
  if (err.code === 3 && state.position) return;
  let msg = Geo.positionErrorMessage(err);
  if (err.code === 1) msg += '設定で許可してから、ページを再読み込みしてください。';
  setStatus(msg);
}

function setPosition(position) {
  state.position = position;
  if (state.map) renderPosition();

  if (position.accuracy > LOW_ACCURACY_M) {
    setStatus(`位置の精度が低下しています（誤差 約${Math.round(position.accuracy)}m）。空が開けた場所で少し待ってください。`);
  } else {
    setStatus(null);
  }

  if (DEBUG) {
    $('debug-pos').textContent =
      `現在地：${position.lat.toFixed(6)}, ${position.lng.toFixed(6)}（地図タブをタップで変更）`;
  }
  updateCompass();
  updateArrival();
}

function renderPosition() {
  const { lat, lng, accuracy } = state.position;
  const latlng = [lat, lng];
  if (!state.userMarker) {
    state.accuracyCircle = L.circle(latlng, {
      radius: accuracy,
      className: 'accuracy-circle',
      interactive: false,
    }).addTo(state.map);
    state.userMarker = L.marker(latlng, {
      icon: L.divIcon({ className: 'user-dot', iconSize: [20, 20], iconAnchor: [10, 10] }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(state.map);
  } else {
    state.userMarker.setLatLng(latlng);
    state.accuracyCircle.setLatLng(latlng);
    state.accuracyCircle.setRadius(accuracy);
  }
}

function setStatus(message) {
  const bar = $('status-bar');
  const wasHidden = bar.hidden;
  bar.textContent = message || '';
  bar.hidden = !message;
  // バーの出し入れで地図の高さが変わるため再計算
  if (state.map && wasHidden !== bar.hidden) state.map.invalidateSize();
}

// ---------- CP詳細パネル ----------
function selectCheckpoint(id) {
  if (!findCheckpoint(id)) return;
  state.selectedId = id;
  $('panel').hidden = false;
  $('main-area').classList.add('has-panel');
  renderPanel();
  renderList();
  syncMarkers();
}

function closePanel() {
  state.selectedId = null;
  state.panelKey = null;
  $('panel').hidden = true;
  $('main-area').classList.remove('has-panel');
  renderList();
  syncMarkers();
}

// パネルの中身を、選択中のCPの状態に合わせて組み立てる
function renderPanel() {
  const cp = selectedCheckpoint();
  if (!cp) return;
  const status = cpStatus(cp.id);

  // CPか状態が変わったときだけ、入力途中の文字とエラーを消す
  const key = `${cp.id}:${status}`;
  if (key !== state.panelKey) {
    state.panelKey = key;
    $('answer-input').value = '';
    $('answer-error').hidden = true;
  }

  $('panel-name').textContent = cp.name;
  $('panel-puzzle').textContent = cp.puzzle;

  const chip = $('panel-status');
  chip.hidden = status === 'locked';
  chip.className = `chip is-${status}`;
  if (status === 'revealed') chip.textContent = '場所が判明';
  if (status === 'cleared') chip.textContent = `クリア済み（${formatClock(state.progress.cleared[cp.id])}）`;

  // コンパスは、場所が判明していてまだクリアしていないCPにだけ出す
  $('panel-compass').hidden = status !== 'revealed';
  updateCompass();
  updateArrival();
}

// ---------- 答え入力欄・現地の問題 ----------
function updateArrival() {
  const cp = selectedCheckpoint();
  if (!cp) return;
  const status = cpStatus(cp.id);
  const form = $('answer-form');
  const guide = $('arrival-guide');
  const site = $('panel-site');
  const wasFormHidden = form.hidden;

  if (status === 'cleared') {
    // クリア済み：入力欄は出さず、現地の問題は読み返せる
    form.hidden = true;
    guide.hidden = true;
    site.hidden = false;
    $('panel-site-question').textContent = cp.siteQuestion;
    return;
  }
  if (isTimeUp()) {
    form.hidden = true;
    guide.hidden = true;
    site.hidden = true;
    return;
  }

  if (status === 'locked') {
    // 謎の答えは、どこにいても入力できる
    site.hidden = true;
    guide.hidden = true;
    form.hidden = false;
    $('answer-label').textContent = '謎の答えを入力してください。どこにいても答えられます。';
  } else {
    // 場所が判明：到着するまで現地の問題は出さない
    const arrived = isArrived(cp);
    site.hidden = !arrived;
    form.hidden = !arrived;
    guide.hidden = arrived;
    if (arrived) {
      $('panel-site-question').textContent = cp.siteQuestion;
      $('answer-label').textContent = '現地に到着しました。現地の問題の答えを入力してください。';
    } else {
      guide.textContent = `チェックポイントに着く（半径${cp.arrivalRadius}m以内に入る）と、現地の問題が出ます。`;
    }
  }
  if (wasFormHidden && !form.hidden) $('answer-error').hidden = true;
}

function onSubmitAnswer(e) {
  e.preventDefault();
  const cp = selectedCheckpoint();
  if (!cp) return;
  const status = cpStatus(cp.id);
  if (status === 'cleared') return;
  const input = $('answer-input');
  const error = $('answer-error');

  // 送信の瞬間にも時刻を確認する
  if (isTimeUp()) {
    error.textContent = '終了時刻を過ぎたため、答えを受け付けられません。';
    error.hidden = false;
    return;
  }
  // 現地の問題は、範囲外に出た直後の送信も受け付けない
  if (status === 'revealed' && !isArrived(cp)) {
    updateArrival();
    return;
  }
  if (normalizeAnswer(input.value) === '') {
    error.textContent = '答えを入力してください。';
    error.hidden = false;
    input.focus();
    return;
  }
  const answers = status === 'locked' ? cp.answer : cp.siteAnswer;
  if (!matchesAnswer(input.value, answers)) {
    error.textContent = '違うようです。もう一度考えてみましょう。';
    error.hidden = false;
    input.select();
    return;
  }

  // 正解
  input.blur();
  input.value = '';
  error.hidden = true;
  if (status === 'locked') revealCheckpoint(cp);
  else clearCheckpoint(cp);
}

// 謎に正解：場所が判明する（locked → revealed）
function revealCheckpoint(cp) {
  state.progress.revealed[cp.id] = now();
  saveProgress();
  refreshAll();
  renderPanel();

  showDialog({
    title: '正解です',
    text: `${cp.name}の場所が判明しました。地図で確認して、現地へ向かいましょう。`,
    okLabel: '地図で見る',
    laterLabel: 'このまま続ける',
    onOk: () => {
      showTab('map');
      selectCheckpoint(cp.id);
      if (state.map) state.map.setView([cp.lat, cp.lng], Math.max(state.map.getZoom(), 17));
    },
  });
}

// 現地の問題に正解：クリアになる（revealed → cleared）
function clearCheckpoint(cp) {
  const t = now();
  state.progress.cleared[cp.id] = t;
  const total = state.data.checkpoints.length;
  const count = clearedCount();
  if (count === total) state.progress.goalAt = t;
  saveProgress();

  refreshAll();
  renderPanel();
  // 全クリアした時点で位置の追跡とコンパスは止める
  if (state.progress.goalAt != null) stopTracking();

  const goal = state.progress.goalAt != null;
  showDialog({
    title: 'クリア！',
    text: goal
      ? `${cp.name}をクリアしました。全${total}か所クリアです！`
      : `${cp.name}をクリアしました（${count} / ${total}）。`,
    okLabel: goal ? '結果を見る' : '続ける',
    onOk: goal ? endGame : null,
  });
}

// ---------- ダイアログ ----------
function showDialog({ title, text, okLabel, laterLabel, onOk }) {
  $('clear-title').textContent = title;
  $('clear-text').textContent = text;
  $('btn-clear-ok').textContent = okLabel;
  $('btn-dialog-later').hidden = !laterLabel;
  if (laterLabel) $('btn-dialog-later').textContent = laterLabel;
  state.dialogOk = onOk || null;
  $('clear-dialog').hidden = false;
  $('btn-clear-ok').focus();
}

function closeDialog(runOk) {
  $('clear-dialog').hidden = true;
  const fn = runOk ? state.dialogOk : null;
  state.dialogOk = null;
  if (fn) fn();
}

// ---------- 残り時間 ----------
function startTicker() {
  if (state.tickTimer) return;
  tick();
}

function tick() {
  clearTimeout(state.tickTimer);
  state.tickTimer = 0;
  if (state.ended) return;

  const remaining = endAtMs() - now();
  if (remaining <= 0) {
    endGame();
    return;
  }
  const el = $('time-left');
  el.textContent = formatRemaining(remaining);
  el.classList.toggle('is-urgent', remaining < URGENT_MS);
  if (DEBUG) {
    $('debug-time').textContent = `時刻：${formatDateTime(now())}:${pad2(new Date(now()).getSeconds())}／終了：${formatDateTime(endAtMs())}`;
  }

  // 表示が次に切り替わる瞬間（残り秒数の境目）に合わせて次回を予約する
  const delay = (remaining % 1000) || 1000;
  state.tickTimer = setTimeout(tick, delay + 5);
}

// デバッグ用の時刻ずらし。リロード後も時間切れの状態を再現できるよう、タブの間だけ保持する
function setDebugOffset(ms) {
  state.debugOffsetMs = ms;
  try { sessionStorage.setItem(DEBUG_OFFSET_KEY, String(ms)); } catch (err) { /* 保持できなくても動作は続ける */ }
  tick();
}

// ---------- ゲーム終了 ----------
function stopTracking() {
  if (state.stopWatch) { state.stopWatch(); state.stopWatch = null; }
  if (state.stopHeading) { state.stopHeading(); state.stopHeading = null; }
  if (state.compassFrame) { cancelAnimationFrame(state.compassFrame); state.compassFrame = 0; }
}

function endGame() {
  if (!state.ended) {
    state.ended = true;
    clearTimeout(state.tickTimer);
    state.tickTimer = 0;
    stopTracking();
  }
  $('clear-dialog').hidden = true;
  state.dialogOk = null;
  $('panel').hidden = true;
  if (document.activeElement) document.activeElement.blur();
  renderEnd();
  $('end-debug').hidden = !DEBUG;
  showScreen('end');
}

function renderEnd() {
  const { data, progress } = state;
  const total = data.checkpoints.length;
  const count = clearedCount();
  const goal = progress.goalAt != null;
  const started = progress.startedAt != null;

  $('end-game-title').textContent = data.gameTitle || '';
  if (goal) {
    $('end-title').textContent = 'ゴール！';
    $('end-sub').textContent = `全${total}か所をクリアしました。`;
  } else if (started) {
    $('end-title').textContent = '時間切れです';
    $('end-sub').textContent = '終了日時になったため、ゲームを終了しました。';
  } else {
    $('end-title').textContent = '終了しました';
    $('end-sub').textContent = 'このゲームは終了日時を過ぎています。';
  }

  // 最終メッセージは、全CPをクリアしたときだけ出す
  $('end-final').hidden = !goal;
  if (goal) $('end-final-text').textContent = data.finalMessage || 'ゴールおめでとうございます！';

  $('end-count').textContent = `${count} / ${total}`;
  $('end-duration-row').hidden = !goal;
  if (goal) $('end-duration').textContent = formatDuration(progress.goalAt - progress.startedAt);
  $('end-started').textContent = started ? formatShortDateTime(progress.startedAt) : '—';
  $('end-fixed-label').textContent = goal ? 'ゴール' : '終了';
  $('end-fixed').textContent = formatShortDateTime(goal ? progress.goalAt : endAtMs());

  $('end-list').replaceChildren(...data.checkpoints.map((cp) => {
    const status = cpStatus(cp.id);
    const li = document.createElement('li');
    li.className = `is-${status}`;
    const name = document.createElement('span');
    name.className = 'end-list-name';
    name.textContent = cp.name;
    const result = document.createElement('span');
    result.className = 'end-list-result';
    result.textContent = status === 'cleared' ? formatClock(progress.cleared[cp.id]) : STATUS_LABEL[status];
    li.append(name, result);
    return li;
  }));
}

// ---------- コンパス ----------
function setHeading(deg) {
  state.heading = deg == null ? null : Geo.normalizeDeg(deg);
  updateCompass();
}

// リロード後の再開時。iOSは許可をタップ操作の中で求め直す必要がある
function resumeHeading() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    state.compassNeedsTap = true;
  } else {
    state.useCompass = true;
  }
}

function onEnableCompass() {
  // await より前に呼ぶ（タップ操作の中で許可を求めるため）
  Geo.requestOrientationPermission().then((result) => {
    state.compassNeedsTap = false;
    if (result === 'granted') {
      state.useCompass = true;
      if (!state.stopHeading && !state.ended) startHeading();
    }
    updateCompass();
  });
}

function startHeading() {
  state.headingWaiting = true;
  state.stopHeading = Geo.watchHeading(onRawHeading);
  setTimeout(() => {
    state.headingWaiting = false;
    updateCompass();
  }, HEADING_WAIT_MS);
}

// センサーの生の値を、単位ベクトルのローパスフィルタで平滑化する
// （角度のまま平均すると 359°と1°の間で大きく振れるため）
function onRawHeading(deg) {
  const rad = (deg * Math.PI) / 180;
  const x = Math.cos(rad);
  const y = Math.sin(rad);
  if (!state.headingVec) {
    state.headingVec = { x, y };
  } else {
    state.headingVec.x += HEADING_SMOOTHING * (x - state.headingVec.x);
    state.headingVec.y += HEADING_SMOOTHING * (y - state.headingVec.y);
  }
  state.heading = Geo.normalizeDeg((Math.atan2(state.headingVec.y, state.headingVec.x) * 180) / Math.PI);
  state.headingWaiting = false;

  // センサーは毎秒数十回届くので、描画は画面の更新に合わせて1回にまとめる
  if (!state.compassFrame) {
    state.compassFrame = requestAnimationFrame(() => {
      state.compassFrame = 0;
      updateCompass();
    });
  }
}

function updateCompass() {
  const cp = selectedCheckpoint();
  // コンパスは場所が判明していてまだクリアしていないCPだけ
  if (!cp || cpStatus(cp.id) !== 'revealed') return;

  const pos = state.position;
  if (!pos) {
    $('compass-distance').textContent = '現在地を取得中…';
    $('compass-dial').hidden = true;
    $('compass-off').hidden = true;
    return;
  }

  // 距離・方位は判定用座標（lat / lng）で計算する
  const dist = Geo.distance(pos.lat, pos.lng, cp.lat, cp.lng);
  $('compass-distance').textContent = `${Math.round(dist).toLocaleString('ja-JP')} m`;

  const hasHeading = state.heading != null;
  $('compass-dial').hidden = !hasHeading;
  $('compass-off').hidden = hasHeading;
  $('btn-compass-enable').hidden = !state.compassNeedsTap;
  if (state.compassNeedsTap) {
    $('compass-unavailable').textContent = 'コンパスを使うには、もう一度許可が必要です。';
  } else if (state.headingWaiting) {
    $('compass-unavailable').textContent = 'コンパスを準備中…';
  } else {
    $('compass-unavailable').textContent = 'コンパスを使えません。残り距離を頼りに進んでください。';
  }
  if (!hasHeading) return;

  const bearing = Geo.bearing(pos.lat, pos.lng, cp.lat, cp.lng);
  const target = Geo.normalizeDeg(bearing - state.heading);
  // 現在の表示角から最短方向（-180〜+180度）に回す
  const delta = ((target - state.arrowAngle) % 360 + 540) % 360 - 180;
  state.arrowAngle += delta;
  $('compass-arrow').style.transform = `rotate(${state.arrowAngle}deg)`;
}

// ---------- デバッグ操作 ----------
function debugRevealAll() {
  const t = now();
  state.data.checkpoints.forEach((cp) => {
    if (state.progress.revealed[cp.id] == null) state.progress.revealed[cp.id] = t;
  });
  saveProgress();
  refreshAll();
  renderPanel();
}

function debugClearAll() {
  const t = now();
  state.data.checkpoints.forEach((cp) => {
    if (state.progress.revealed[cp.id] == null) state.progress.revealed[cp.id] = t;
    if (state.progress.cleared[cp.id] == null) state.progress.cleared[cp.id] = t;
  });
  state.progress.goalAt = t;
  saveProgress();
  endGame();
}

// ---------- 起動 ----------
function showLoadError(message) {
  const box = $('load-error');
  box.textContent = message;
  box.hidden = false;
}

async function boot() {
  $('btn-start').addEventListener('click', () => onStart(true));
  $('btn-start-nocompass').addEventListener('click', () => onStart(false));
  $('tab-list').addEventListener('click', () => showTab('list'));
  $('tab-map').addEventListener('click', () => showTab('map'));
  $('btn-fit').addEventListener('click', fitPins);
  $('panel-close').addEventListener('click', closePanel);
  $('answer-form').addEventListener('submit', onSubmitAnswer);
  $('btn-clear-ok').addEventListener('click', () => closeDialog(true));
  $('btn-dialog-later').addEventListener('click', () => closeDialog(false));
  $('debug-goto').addEventListener('click', () => {
    const cp = selectedCheckpoint();
    if (cp) setPosition({ lat: cp.lat, lng: cp.lng, accuracy: 0 });
  });
  $('debug-reveal-all').addEventListener('click', debugRevealAll);
  $('debug-clear-all').addEventListener('click', debugClearAll);
  document.querySelectorAll('[data-debug-advance]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setDebugOffset(state.debugOffsetMs + Number(btn.dataset.debugAdvance));
    });
  });
  $('debug-near-end').addEventListener('click', () => {
    setDebugOffset(endAtMs() - 10 * 1000 - Date.now());
  });
  document.querySelectorAll('[data-debug-reset]').forEach((btn) => {
    btn.addEventListener('click', resetProgress);
  });
  $('btn-compass-enable').addEventListener('click', onEnableCompass);
  // 画面を閉じていた・バックグラウンドだった場合は、戻った時点の時刻で再計算する
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.tickTimer) tick();
  });
  window.addEventListener('pageshow', () => { if (state.tickTimer) tick(); });
  $('debug-heading').addEventListener('input', (e) => {
    $('debug-heading-value').textContent = `${e.target.value}°`;
    setHeading(Number(e.target.value));
  });

  try {
    state.data = await loadData();
  } catch (err) {
    showLoadError(err.message);
    return;
  }
  if (Number.isNaN(endAtMs())) {
    showLoadError('checkpoints.json の endAt の書式が正しくありません（例："2026-11-30T16:00:00+09:00"）。');
    return;
  }
  if (DEBUG) {
    try { state.debugOffsetMs = Number(sessionStorage.getItem(DEBUG_OFFSET_KEY)) || 0; } catch (err) { /* なし */ }
  }
  loadProgress();

  // ゴール済み、またはすでに終了日時を過ぎていたら結果画面（スタートさせない）
  if (state.progress.goalAt != null || isTimeUp()) {
    endGame();
    return;
  }
  // スタート済みの端末はスタート画面を飛ばしてメイン画面へ
  if (state.progress.startedAt != null) {
    if (!DEBUG) resumeHeading();
    enterMain();
    return;
  }
  renderStart();
}

boot();
