/**
 * The viewer page served by the cdp-screencast bridge. Deliberately tiny and
 * dependency-free: it draws JPEG frames into a canvas that scales to the
 * sidecar, and sends mouse/keyboard/wheel events back with coordinates
 * normalized against the frame.
 *
 * It honours the same query parameters the desktop passes to noVNC
 * (`path=<relay sub-path>/websockify`, `autoconnect`, `reconnect`) so the
 * desktop needs no provider-specific URL code.
 */
export const ELECTRON_GUI_VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Electron GUI Preview</title>
<style>
  html, body { margin: 0; height: 100%; background: #1f1f1f; overflow: hidden; }
  #stage { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
  canvas { max-width: 100%; max-height: 100%; outline: none; image-rendering: auto; }
  #status { position: absolute; left: 0; right: 0; top: 0; padding: 6px 12px; font: 13px system-ui, sans-serif;
            color: #eee; background: rgba(0,0,0,.55); text-align: center; }
  #status[hidden] { display: none; }
</style>
</head>
<body>
<div id="stage"><canvas id="screen" tabindex="0" width="1280" height="800"></canvas></div>
<div id="status">Electron 앱 화면에 연결하는 중…</div>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var canvas = document.getElementById('screen');
  var ctx = canvas.getContext('2d');
  var status = document.getElementById('status');
  var reconnect = params.get('reconnect') !== 'false';
  var socket = null;

  function socketUrl() {
    var path = params.get('path');
    var base;
    if (path) {
      base = '/' + path.replace(/^\\/+/, '');
    } else {
      var dir = location.pathname.replace(/[^/]*$/, '');
      base = dir + 'websockify';
    }
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base;
  }

  function setStatus(text) { if (text) { status.textContent = text; status.hidden = false; } else { status.hidden = true; } }

  function drawFrame(msg) {
    var img = new Image();
    img.onload = function () {
      if (canvas.width !== img.width || canvas.height !== img.height) { canvas.width = img.width; canvas.height = img.height; }
      ctx.drawImage(img, 0, 0);
    };
    img.src = 'data:image/jpeg;base64,' + msg.data;
  }

  function send(obj) { if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj)); }

  function normalized(ev) {
    var rect = canvas.getBoundingClientRect();
    var nx = (ev.clientX - rect.left) / rect.width;
    var ny = (ev.clientY - rect.top) / rect.height;
    return { nx: Math.min(1, Math.max(0, nx)), ny: Math.min(1, Math.max(0, ny)) };
  }

  function modifiersOf(ev) {
    return (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0);
  }

  var BUTTONS = ['left', 'middle', 'right'];
  function mouse(kind, ev) {
    var p = normalized(ev);
    var button = kind === 'mouseMoved' ? 'none' : (BUTTONS[ev.button] || 'left');
    send({ t: 'mouse', kind: kind, nx: p.nx, ny: p.ny, button: button, clickCount: kind === 'mouseMoved' ? 0 : (ev.detail || 1), modifiers: modifiersOf(ev) });
  }

  canvas.addEventListener('mousedown', function (ev) { canvas.focus(); ev.preventDefault(); mouse('mousePressed', ev); });
  canvas.addEventListener('mouseup', function (ev) { ev.preventDefault(); mouse('mouseReleased', ev); });
  canvas.addEventListener('mousemove', function (ev) { mouse('mouseMoved', ev); });
  canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  canvas.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var p = normalized(ev);
    send({ t: 'wheel', nx: p.nx, ny: p.ny, deltaX: ev.deltaX, deltaY: ev.deltaY, modifiers: modifiersOf(ev) });
  }, { passive: false });

  function key(kind, ev) {
    var text = ev.key.length === 1 ? ev.key : (ev.key === 'Enter' ? '\\r' : '');
    send({ t: 'key', kind: kind, key: ev.key, code: ev.code, text: text, modifiers: modifiersOf(ev) });
  }
  canvas.addEventListener('keydown', function (ev) { ev.preventDefault(); key('keyDown', ev); });
  canvas.addEventListener('keyup', function (ev) { ev.preventDefault(); key('keyUp', ev); });

  function connect() {
    setStatus('Electron 앱 화면에 연결하는 중…');
    socket = new WebSocket(socketUrl());
    socket.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.t === 'frame') { setStatus(null); drawFrame(msg); }
      else if (msg.t === 'ready') { setStatus('Electron 창을 기다리는 중…'); }
      else if (msg.t === 'error') { setStatus(msg.reason === 'busy' ? '다른 뷰어가 이미 이 화면을 보고 있습니다.' : ('화면 스트림 오류: ' + (msg.message || msg.reason))); }
    };
    socket.onclose = function () {
      setStatus('연결이 끊겼습니다.' + (reconnect ? ' 다시 연결하는 중…' : ''));
      if (reconnect) setTimeout(connect, 1500);
    };
    socket.onerror = function () { /* onclose follows */ };
  }
  connect();
})();
</script>
</body>
</html>
`
