/* ══════════════════════════════════════
   MEDISCAN · App Logic
   API: Groq (vision models)
   Locked system prompt — users only set API key + model
══════════════════════════════════════ */

const App = (() => {

  /* ─── State ─── */
  const S = {
    screen: 'screen-capture',
    rawImage: null,
    redactedImage: null,
    boxes: [],
    penStrokes: [],
    tool: 'draw',
    drawing: false,
    sx: 0, sy: 0,
    liveBox: null,
    livePen: null,
    penSize: 12,
    history: [],
    streaming: false,
    drawerOpen: false,
  };

  /* ─── Locked system prompt ─── */
  const SYSTEM_PROMPT = `You are a concise, empathetic medical document assistant.
The user has photographed a medical document. Any black-filled rectangles are privacy redactions — ignore them completely.
Analyse only the visible medical content and respond with:
1. A plain-language summary of the key findings or instructions
2. Medications, dosages, or treatments mentioned (if any)
3. Any follow-up steps, appointments, or action items
4. Medical terms the patient may want to discuss with their doctor

Keep your tone warm and clear. End with a brief reminder to confirm details with their healthcare provider.`;

  /* ─── Settings ─── */
  const DEFAULTS = { apiKey: '', model: 'meta-llama/llama-4-maverick-17b-128e-instruct' };

  function cfg() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('ms_cfg') || '{}') }; }
    catch { return { ...DEFAULTS }; }
  }

  function saveSettings() {
    const key   = document.getElementById('apiKeyInput').value.trim();
    const model = document.getElementById('modelSelect').value;
    localStorage.setItem('ms_cfg', JSON.stringify({ apiKey: key, model }));
    closeSettings();
    toast('Saved', 'ok');
  }

  function openSettings() {
    const c = cfg();
    document.getElementById('apiKeyInput').value = c.apiKey;
    document.getElementById('modelSelect').value = c.model;
    document.getElementById('settingsSheet').style.display = 'flex';
  }

  function closeSettings() {
    document.getElementById('settingsSheet').style.display = 'none';
  }

  function sheetBackdropClick(e) {
    if (e.target === document.getElementById('settingsSheet')) closeSettings();
  }

  /* ─── Navigation ─── */
  function goTo(id) {
    if (id === S.screen) return;
    const from = document.getElementById(S.screen);
    const to   = document.getElementById(id);
    if (!to) return;

    from.classList.add('leaving');
    setTimeout(() => from.classList.remove('active', 'leaving'), 280);

    to.classList.add('active');
    S.screen = id;

    if (id === 'screen-redact' && S.rawImage) requestAnimationFrame(initCanvas);
  }

  /* ─── Image capture ─── */
  function openCamera()  { document.getElementById('cameraInput').click(); }
  function openGallery() { document.getElementById('galleryInput').click(); }

  function handleImageFile(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = e => {
      S.rawImage = e.target.result;
      S.boxes    = [];

      const img   = document.getElementById('capturedImage');
      const zone  = document.getElementById('imageZone');
      const ph    = document.getElementById('zonePlaceholder');

      img.src          = S.rawImage;
      img.style.display = 'block';
      ph.style.display  = 'none';
      zone.classList.add('filled');

      document.getElementById('btnToRedact').style.display = 'flex';
      input.value = '';
    };
    reader.readAsDataURL(file);
  }

  /* ─── Canvas / redaction ─── */
  let canvas, ctx, imgEl;

  function initCanvas() {
    canvas = document.getElementById('redactCanvas');
    ctx    = canvas.getContext('2d');

    // Remove stale listeners by cloning
    const fresh = canvas.cloneNode(true);
    canvas.parentNode.replaceChild(fresh, canvas);
    canvas = fresh;
    ctx    = canvas.getContext('2d');

    imgEl = new Image();
    imgEl.onload = () => {
      const wrap  = document.getElementById('canvasWrap');
      const maxW  = wrap.clientWidth  - 32;
      const maxH  = wrap.clientHeight - 32;
      const scale = Math.min(maxW / imgEl.width, maxH / imgEl.height, 1);

      canvas.width  = Math.round(imgEl.width  * scale);
      canvas.height = Math.round(imgEl.height * scale);
      canvas._scale = scale;

      renderCanvas();
    };
    imgEl.src = S.rawImage;

    canvas.addEventListener('pointerdown',  pDown,   { passive: false });
    canvas.addEventListener('pointermove',  pMove,   { passive: false });
    canvas.addEventListener('pointerup',    pUp,     { passive: false });
    canvas.addEventListener('pointercancel', pUp,    { passive: false });
  }

  function renderCanvas() {
    if (!ctx || !imgEl) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
    S.boxes.forEach(b => paintBox(b, false));
    if (S.drawing && S.liveBox) paintBox(S.liveBox, true);
    S.penStrokes.forEach(s => paintPenStroke(s, false));
    if (S.drawing && S.livePen) paintPenStroke(S.livePen, true);
    document.getElementById('boxCount').textContent =
      `${S.boxes.length} box${S.boxes.length !== 1 ? 'es' : ''}`;
  }

  function paintBox(b, live) {
    ctx.fillStyle = '#1a1612';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = live ? '#c8840a' : 'rgba(200,132,10,.7)';
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(b.x + .75, b.y + .75, b.w - 1.5, b.h - 1.5);
    // No REDACTED text — just a clean black box
  }

  function paintPenStroke(stroke, live) {
    if (!stroke || stroke.points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = '#1a1612';
    ctx.lineWidth   = stroke.size || 12;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function pt(e) {
    const r  = canvas.getBoundingClientRect();
    const sx = canvas.width  / r.width;
    const sy = canvas.height / r.height;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  function pDown(e) {
    e.preventDefault();
    const p = pt(e);
    if (S.tool === 'draw') {
      S.drawing = true;
      S.sx = p.x; S.sy = p.y;
      S.liveBox = { x: p.x, y: p.y, w: 0, h: 0 };
      canvas.setPointerCapture(e.pointerId);
    } else if (S.tool === 'pen') {
      S.drawing = true;
      S.livePen = { points: [p], size: S.penSize };
      canvas.setPointerCapture(e.pointerId);
    } else {
      // erase: check boxes
      const i = S.boxes.findIndex(b => {
        const x1 = Math.min(b.x, b.x+b.w), x2 = Math.max(b.x, b.x+b.w);
        const y1 = Math.min(b.y, b.y+b.h), y2 = Math.max(b.y, b.y+b.h);
        return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
      });
      if (i !== -1) { S.boxes.splice(i, 1); renderCanvas(); return; }
      // erase: check pen strokes (remove last one touching near point)
      const si = S.penStrokes.findLastIndex(s =>
        s.points.some(pt2 => Math.hypot(pt2.x - p.x, pt2.y - p.y) < (s.size || 12) * 1.5)
      );
      if (si !== -1) { S.penStrokes.splice(si, 1); renderCanvas(); }
    }
  }

  function pMove(e) {
    e.preventDefault();
    if (!S.drawing) return;
    const p = pt(e);
    if (S.tool === 'draw') {
      S.liveBox = { x: S.sx, y: S.sy, w: p.x - S.sx, h: p.y - S.sy };
    } else if (S.tool === 'pen' && S.livePen) {
      S.livePen.points.push(p);
    }
    renderCanvas();
  }

  function pUp(e) {
    e.preventDefault();
    if (!S.drawing) return;
    S.drawing = false;
    if (S.tool === 'draw') {
      const b = S.liveBox;
      if (b && Math.abs(b.w) > 8 && Math.abs(b.h) > 8) S.boxes.push({ ...b });
      S.liveBox = null;
    } else if (S.tool === 'pen' && S.livePen) {
      if (S.livePen.points.length > 1) S.penStrokes.push({ ...S.livePen, points: [...S.livePen.points] });
      S.livePen = null;
    }
    renderCanvas();
  }

  function setTool(t) {
    S.tool = t;
    document.getElementById('toolBox').classList.toggle('active', t === 'draw');
    document.getElementById('toolPen').classList.toggle('active', t === 'pen');
    document.getElementById('toolErase').classList.toggle('active', t === 'erase');
    if (t === 'draw') canvas.style.cursor = 'crosshair';
    else if (t === 'pen') canvas.style.cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\'%3E%3Cpath fill=\'%231a1612\' d=\'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z\'/%3E%3C/svg%3E") 0 24, crosshair';
    else canvas.style.cursor = 'cell';
    // Show/hide pen size slider
    const sizeRow = document.getElementById('penSizeRow');
    if (sizeRow) sizeRow.style.display = t === 'pen' ? 'flex' : 'none';
  }

  function setPenSize(val) {
    S.penSize = parseInt(val, 10);
    const lbl = document.getElementById('penSizeLabel');
    if (lbl) lbl.textContent = val + 'px';
  }

  function clearBoxes() { S.boxes = []; S.penStrokes = []; renderCanvas(); }

  /* ─── Export censored image ─── */
  function exportRedacted() {
    return new Promise(resolve => {
      const off  = document.createElement('canvas');
      off.width  = imgEl.naturalWidth  || imgEl.width;
      off.height = imgEl.naturalHeight || imgEl.height;
      const oc   = off.getContext('2d');
      oc.drawImage(imgEl, 0, 0, off.width, off.height);

      const inv = 1 / (canvas._scale || 1);

      // Burn boxes
      S.boxes.forEach(b => {
        oc.fillStyle = '#1a1612';
        oc.fillRect(b.x * inv, b.y * inv, b.w * inv, b.h * inv);
      });

      // Burn pen strokes
      S.penStrokes.forEach(s => {
        if (!s || s.points.length < 2) return;
        oc.save();
        oc.strokeStyle = '#1a1612';
        oc.lineWidth   = (s.size || 12) * inv;
        oc.lineCap     = 'round';
        oc.lineJoin    = 'round';
        oc.beginPath();
        oc.moveTo(s.points[0].x * inv, s.points[0].y * inv);
        for (let i = 1; i < s.points.length; i++) {
          oc.lineTo(s.points[i].x * inv, s.points[i].y * inv);
        }
        oc.stroke();
        oc.restore();
      });

      resolve(off.toDataURL('image/jpeg', 0.92));
    });
  }

  /* ─── Proceed to analysis ─── */
  async function proceedToAnalysis() {
    const c = cfg();
    if (!c.apiKey) { toast('Add your Groq API key in Settings ⚙', 'err'); openSettings(); return; }

    S.redactedImage = await exportRedacted();

    // Set thumb
    document.getElementById('chatThumb').src    = S.redactedImage;
    document.getElementById('scannedFull').src  = S.redactedImage;

    // Reset chat
    S.history = [];
    S.drawerOpen = false;
    document.getElementById('scannedDrawer').style.display = 'none';
    document.getElementById('chatMessages').innerHTML = '';
    document.getElementById('suggestions').innerHTML  = '';

    goTo('screen-processing');

    // Brief animation pause then go to chat and start streaming
    setTimeout(async () => {
      goTo('screen-chat');
      await analyzeDoc();
    }, 900);
  }

  /* ─── Groq API (OpenAI-compatible, streaming) ─── */
  async function callGroq(messages, onDelta) {
    const c = cfg();

    const body = {
      model:       c.model,
      max_tokens:  1500,
      temperature: 0.4,
      stream:      true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
      ],
    };

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Groq error ${res.status}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const ev = JSON.parse(raw);
          const delta = ev.choices?.[0]?.delta?.content;
          if (delta) { full += delta; onDelta(full); }
        } catch {}
      }
    }
    return full;
  }

  /* ─── First analysis ─── */
  async function analyzeDoc() {
    const b64 = S.redactedImage.replace(/^data:image\/\w+;base64,/, '');
    const mt  = S.redactedImage.match(/^data:(image\/\w+);/)?.[1] || 'image/jpeg';

    const firstMsg = {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mt};base64,${b64}` } },
        { type: 'text', text: 'Please analyse this medical document. Any black rectangles are privacy redactions — focus only on the visible medical content.' },
      ],
    };

    S.history    = [firstMsg];
    S.streaming  = true;

    const win    = document.getElementById('chatMessages');
    const bubble = addBubble('ai');

    try {
      const full = await callGroq(S.history, text => {
        updateBubble(bubble, text, true);
        win.scrollTop = win.scrollHeight;
      });

      updateBubble(bubble, full, false);
      S.history.push({ role: 'assistant', content: full });
      showSuggestions(full);
    } catch (err) {
      updateBubble(bubble, `Could not analyse document — ${err.message}`, false);
      toast(err.message, 'err');
    } finally {
      S.streaming = false;
    }
  }

  /* ─── Follow-up ─── */
  async function sendFollowUp(text) {
    const input = document.getElementById('chatInput');
    const msg   = (text ?? input.value).trim();
    if (!msg || S.streaming) return;

    input.value = '';
    autoResize(input);
    document.getElementById('suggestions').innerHTML = '';

    addBubble('user', msg);
    S.history.push({ role: 'user', content: msg });

    S.streaming = true;
    document.getElementById('sendBtn').disabled = true;

    const win    = document.getElementById('chatMessages');
    const bubble = addBubble('ai');

    try {
      const full = await callGroq(S.history, text => {
        updateBubble(bubble, text, true);
        win.scrollTop = win.scrollHeight;
      });

      updateBubble(bubble, full, false);
      S.history.push({ role: 'assistant', content: full });
      showSuggestions(full);
    } catch (err) {
      updateBubble(bubble, `Error: ${err.message}`, false);
      toast(err.message, 'err');
    } finally {
      S.streaming = false;
      document.getElementById('sendBtn').disabled = false;
    }
  }

  /* ─── Scanned image drawer toggle ─── */
  function toggleScannedText() {
    S.drawerOpen = !S.drawerOpen;
    const drawer = document.getElementById('scannedDrawer');
    drawer.style.display = S.drawerOpen ? 'block' : 'none';
  }

  /* ─── Suggestions ─── */
  const CHIPS = [
    'What medications are mentioned?',
    'Are there follow-up appointments?',
    'Explain these terms simply',
    'What should I watch for?',
    'What are my next steps?',
    'What questions should I ask my doctor?',
  ];

  function showSuggestions(response) {
    const el = document.getElementById('suggestions');
    el.innerHTML = '';

    let pool = [...CHIPS];
    if (response.toLowerCase().includes('medic')) pool.unshift('What medications are mentioned?');
    if (response.toLowerCase().includes('appoint')) pool.unshift('Are there follow-up appointments?');
    pool = [...new Set(pool)].slice(0, 4);

    pool.forEach(q => {
      const btn = document.createElement('button');
      btn.className   = 'sug-chip';
      btn.textContent = q;
      btn.onclick     = () => sendFollowUp(q);
      el.appendChild(btn);
    });
  }

  /* ─── DOM helpers ─── */
  function addBubble(role, text = '') {
    const win = document.getElementById('chatMessages');
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;

    const lbl = document.createElement('div');
    lbl.className   = 'msg-role';
    lbl.textContent = role === 'user' ? 'You' : 'MediScan';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (role === 'ai' && !text) {
      // Show typing dots first
      bubble.innerHTML = `<div class="typing-bubble"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>`;
    } else {
      bubble.innerHTML = renderMd(text);
    }

    wrap.appendChild(lbl);
    wrap.appendChild(bubble);
    win.appendChild(wrap);
    win.scrollTop = win.scrollHeight;

    return bubble;
  }

  function updateBubble(el, text, streaming) {
    el.innerHTML = renderMd(text);
    if (streaming) el.classList.add('streaming');
    else           el.classList.remove('streaming');
  }

  /* ─── Lightweight markdown ─── */
  function renderMd(t) {
    if (!t) return '';
    return t
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^### (.+)$/gm,  '<h3>$1</h3>')
      .replace(/^## (.+)$/gm,   '<h2>$1</h2>')
      .replace(/^# (.+)$/gm,    '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,     '<em>$1</em>')
      .replace(/`(.+?)`/g,       '<code>$1</code>')
      .replace(/^- (.+)$/gm,     '<li>$1</li>')
      .replace(/(<li>[\s\S]+?<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^(?!<[hul])(.+)$/, '<p>$1</p>');
  }

  /* ─── Input helpers ─── */
  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollowUp(); }
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 110) + 'px';
  }

  /* ─── Toast ─── */
  function toast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className   = `toast show ${type}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3200);
  }

  /* ─── Service worker ─── */
  function registerSW() {
    if ('serviceWorker' in navigator)
      navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  /* ─── Init ─── */
  function init() {
    registerSW();
    // Drag-and-drop on image zone
    const zone = document.getElementById('imageZone');
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = ev => {
          S.rawImage = ev.target.result;
          S.boxes    = [];
          document.getElementById('capturedImage').src          = S.rawImage;
          document.getElementById('capturedImage').style.display = 'block';
          document.getElementById('zonePlaceholder').style.display = 'none';
          document.getElementById('imageZone').classList.add('filled');
          document.getElementById('btnToRedact').style.display   = 'flex';
        };
        reader.readAsDataURL(file);
      }
    });
  }

  return {
    goTo, openCamera, openGallery, handleImageFile,
    setTool, setPenSize, clearBoxes, proceedToAnalysis,
    sendFollowUp, handleKey, autoResize,
    openSettings, closeSettings, saveSettings, sheetBackdropClick,
    toggleScannedText,
    init,
  };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
