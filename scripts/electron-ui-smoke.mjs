import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const server = createServer();
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const port = server.address().port;
await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));

const child = spawn(executable, [
  '--remote-debugging-port=' + port,
  '--remote-allow-origins=*',
  '--disable-gpu',
  '.',
], { cwd: root, stdio: 'ignore', windowsHide: true });
let socket;
const exceptions = [];
const waitUntil = async (read, predicate, description, timeoutMs = 45_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Electron exited before ' + description + ' (code ' + child.exitCode + ')');
    const value = await read();
    if (predicate(value)) return value;
    await delay(150);
  }
  throw new Error('Timed out waiting for ' + description);
};

try {
  const target = await waitUntil(async () => {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list');
      if (!response.ok) return null;
      const pages = await response.json();
      return pages.find(page => page.type === 'page' && page.url.startsWith('http://127.0.0.1:')) || null;
    } catch { return null; }
  }, Boolean, 'the SONORA window');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting to Electron DevTools')), 10_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to Electron DevTools')); }, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text || 'Renderer exception');
    if (message.id && pending.has(message.id)) {
      const { resolve: resolveMessage, reject: rejectMessage } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectMessage(new Error(message.error.message));
      else resolveMessage(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolveMessage, rejectMessage) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveMessage, reject: rejectMessage });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Renderer evaluation failed');
    return response.result?.value;
  };
  const ready = await waitUntil(
    () => evaluate("document.readyState === 'complete' && Boolean(document.querySelector('#workspace'))"),
    Boolean,
    'the SONORA interface',
  );
  assert.equal(ready, true);
  assert.equal(await evaluate('document.title'), 'SONORA — музыкальная студия');
  assert.deepEqual(await evaluate("(()=>({canvas:document.querySelector('#spectrumCanvas')?.getAttribute('role'),label:document.querySelector('#spectrumCanvas')?.getAttribute('aria-label'),summary:document.querySelector('#spectrumSummary')?.textContent}))()"),{canvas:'img',label:'Спектральный анализатор мастер-выхода',summary:'Нет сигнала'},'accessible spectrum analyzer widget');
  assert.equal(await evaluate("Boolean(document.querySelector('[data-inspector-effect=equalizer]'))"), true);
  await evaluate("document.querySelector('#addPanAutomationBtn').click()");
  assert.deepEqual(await evaluate("(()=>({label:document.querySelector('.automation-summary strong')?.textContent,min:document.querySelector('.automation-value')?.min,max:document.querySelector('.automation-value')?.max,points:document.querySelectorAll('.automation-value').length}))()"),{label:'Аудио 1 · панорама',min:'-1',max:'1',points:2},'pan automation lane and bounded controls');
  await evaluate("document.querySelector('#undoBtn').click()");
  await waitUntil(()=>evaluate("document.querySelector('.automation-summary')===null"),Boolean,'pan automation undo');
  await evaluate("document.querySelector('#tab-view-arrangement').click()");
  await waitUntil(()=>evaluate("document.querySelector('#tab-view-arrangement')?.getAttribute('aria-selected')==='true' && document.querySelector('.automation-summary')===null"),Boolean,'return to Arrangement after automation undo');


  await evaluate("document.querySelector('[data-inspector-effect=equalizer]').click()");
  const initialBands = await waitUntil(
    () => evaluate("document.querySelectorAll('[data-eq=frequencyHz][data-eq-band]').length"),
    count => count === 7,
    'seven accessible EQ frequency controls',
  );
  assert.equal(initialBands, 7);

  await evaluate("(() => { const input = document.querySelectorAll('[data-eq=frequencyHz][data-eq-band]')[2]; input.value = '575'; input.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await evaluate("(() => { const input = document.querySelectorAll('[data-eq=gainDb][data-eq-band]')[2]; input.value = '4.5'; input.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await evaluate("(() => { const input = document.querySelector('#inspectorEqQ'); input.value = '1.4'; input.dispatchEvent(new Event('input', { bubbles: true })); })()");
  const edited = await evaluate("(() => { const frequency = document.querySelectorAll('[data-eq=frequencyHz][data-eq-band]')[2]; const gain = document.querySelectorAll('[data-eq=gainDb][data-eq-band]')[2]; return { frequency: Number(frequency.value), gain: Number(gain.value), gainLabel: gain.parentElement.querySelector('output').textContent, q: Number(document.querySelector('#inspectorEqQ').value) }; })()");
  assert.deepEqual(edited, { frequency: 575, gain: 4.5, gainLabel: '4.5 dB', q: 1.4 });
  await evaluate("document.querySelector('[data-inspector-effect=compressor]').click()");
  const compressorControls=await waitUntil(()=>evaluate("document.querySelectorAll('[data-compressor]').length"),count=>count===5,'five accessible compressor controls');
  assert.equal(compressorControls,5);
  await evaluate("(() => { const values={thresholdDb:'-24',ratio:'6',attackMs:'5',releaseMs:'240',makeupDb:'2'}; for(const input of document.querySelectorAll('[data-compressor]')){input.value=values[input.dataset.compressor];input.dispatchEvent(new Event('input',{bubbles:true}));} })()");
  const compressorState=await evaluate("(()=>Object.fromEntries([...document.querySelectorAll('[data-compressor]')].map(input=>[input.dataset.compressor,Number(input.value)])))()");
  assert.deepEqual(compressorState,{thresholdDb:-24,ratio:6,attackMs:5,releaseMs:240,makeupDb:2});
  await evaluate("document.querySelector('[data-inspector-effect=limiter]').click()");
  const limiterControls=await waitUntil(()=>evaluate("document.querySelectorAll('[data-limiter]').length"),count=>count===2,'limiter ceiling and release controls');
  assert.equal(limiterControls,2);
  await evaluate("(() => { const values={ceilingDb:'-3.5',releaseMs:'125'}; for(const input of document.querySelectorAll('[data-limiter]')){input.value=values[input.dataset.limiter];input.dispatchEvent(new Event('input',{bubbles:true}));} })()");
  assert.deepEqual(await evaluate("(()=>Object.fromEntries([...document.querySelectorAll('[data-limiter]')].map(input=>[input.dataset.limiter,Number(input.value)])))()"),{ceilingDb:-3.5,releaseMs:125});
  await delay(200);
  assert.deepEqual(exceptions, [], 'the EQ interaction must not throw renderer exceptions');
  const imported = await evaluate(`(() => {
    const sampleRate = 48_000, frames = sampleRate * 2;
    const header = new Uint8Array(44), view = new DataView(header.buffer);
    const write = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
    write(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, frames * 2, true);
    const pcm = new Uint8Array(frames * 2), pcmView = new DataView(pcm.buffer);
    for (let frame = 0; frame < frames; frame++) pcmView.setInt16(frame * 2, Math.round(Math.sin(2 * Math.PI * 440 * frame / sampleRate) * 2500), true);
    const file = new File([header, pcm], 'qa-split.wav', { type: 'audio/wav' });
    const transfer = new DataTransfer(); transfer.items.add(file);
    const input = document.querySelector('#audioFiles'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { sampleRate, frames, peak: 2500 / 32768 };
  })()`);
  assert.deepEqual(imported, { sampleRate: 48000, frames: 96000, peak: 2500 / 32768 });
  await waitUntil(
    () => evaluate("document.querySelectorAll('.track-lane .clip').length"),
    count => count === 1,
    'the disposable two-second audio clip',
  );
  const clickPoint = await evaluate("(() => { const rect=document.querySelector('.track-lane .clip').getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}; })()");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickPoint.x, y: clickPoint.y, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickPoint.x, y: clickPoint.y, button: 'left' });
  await evaluate("document.querySelector('#undoBtn').click()");
  await waitUntil(
    () => evaluate("document.querySelectorAll('.track-lane .clip').length"),
    count => count === 0,
    'clip selection does not create a spurious undo entry',
  );
  await evaluate("document.querySelector('#redoBtn').click()");
  await waitUntil(
    () => evaluate("document.querySelectorAll('.track-lane .clip').length"),
    count => count === 1,
    'redo restores the imported clip after no-op selection',
  );
  const clipWidthAtDefaultZoom = await evaluate("parseFloat(document.querySelector('.track-lane .clip').style.width)");
  await evaluate("(() => { const input=document.querySelector('#zoomInput'); input.value='150'; input.dispatchEvent(new Event('input',{bubbles:true})); })()");
  const clipWidthZoomedIn = await waitUntil(
    () => evaluate("parseFloat(document.querySelector('.track-lane .clip')?.style.width)"),
    width => width > clipWidthAtDefaultZoom,
    'Arrangement zoom-in expands clip geometry',
  );
  await evaluate("(() => { const input=document.querySelector('#zoomInput'); input.value='70'; input.dispatchEvent(new Event('input',{bubbles:true})); })()");
  await waitUntil(
    () => evaluate("parseFloat(document.querySelector('.track-lane .clip')?.style.width)"),
    width => width > 0 && width < clipWidthAtDefaultZoom,
    'Arrangement zoom-out contracts clip geometry',
  );
  await evaluate("(() => { const input=document.querySelector('#zoomInput'); input.value='106'; input.dispatchEvent(new Event('input',{bubbles:true})); })()");
  const zoomRulerPoint = await evaluate("(() => { const scroll=document.querySelector('#timelineScroll'); scroll.scrollLeft=80; const ruler=document.querySelector('#barRuler').getBoundingClientRect(); const beat=5.5; return {x:ruler.left+106*beat/4,y:ruler.top+ruler.height/2,beat}; })()");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: zoomRulerPoint.x, y: zoomRulerPoint.y, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: zoomRulerPoint.x, y: zoomRulerPoint.y, button: 'left' });
  const playheadAtDefaultZoom = await evaluate("parseFloat(document.querySelector('#playheadLine').style.left)");
  assert.ok(Math.abs(playheadAtDefaultZoom - zoomRulerPoint.beat * 106 / 4) < .5, 'ruler pointer maps to the same beat after horizontal scrolling');
  await evaluate("(() => { const input=document.querySelector('#zoomInput'); input.value='150'; input.dispatchEvent(new Event('input',{bubbles:true})); })()");
  const playheadAtZoomedIn = await evaluate("parseFloat(document.querySelector('#playheadLine').style.left)");
  assert.ok(Math.abs(playheadAtZoomedIn - zoomRulerPoint.beat * 150 / 4) < .5, 'zoom preserves the playhead beat');
  await evaluate("(() => { const input=document.querySelector('#zoomInput'); input.value='106'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#timelineScroll').scrollLeft=0; })()");
  assert.ok(clipWidthZoomedIn > clipWidthAtDefaultZoom, 'Arrangement geometry scales from beat units');
  await evaluate("(() => { const rate = document.querySelector('#clipRate'); rate.value = '1.5'; rate.dispatchEvent(new Event('input', { bubbles: true })); })()");
  const rulerPoint = await evaluate(`(() => {
    const ruler = document.querySelector('#barRuler'), bounds = ruler.getBoundingClientRect();
    const barWidth = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar'));
    return { x: bounds.left + barWidth * 1.25 / 4, y: bounds.top + bounds.height / 2 };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rulerPoint.x, y: rulerPoint.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rulerPoint.x, y: rulerPoint.y, button: 'left', clickCount: 1 });
  await evaluate("document.querySelector('#splitTool').click()");
  const originalClip = await evaluate(`(() => { const rect = document.querySelector('.track-lane .clip').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: originalClip.x, y: originalClip.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: originalClip.x, y: originalClip.y, button: 'left', clickCount: 1 });
  await waitUntil(
    () => evaluate("document.querySelectorAll('.track-lane .clip').length"),
    count => count === 2,
    'the two clips created at the playhead',
  );
  const rightClip = await evaluate(`(() => { const rect = document.querySelectorAll('.track-lane .clip')[1].getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rightClip.x, y: rightClip.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rightClip.x, y: rightClip.y, button: 'left', clickCount: 1 });
  const splitOffset = await waitUntil(
    () => evaluate("Number(document.querySelector('#clipOffset')?.value)"),
    value => Math.abs(value - .94) < .005,
    'the source offset on the retimed right-hand clip',
  );
  assert.ok(Math.abs(splitOffset - .94) < .005);
  const originalRate = await evaluate("Number(document.querySelector('#clipRate')?.value)");
  assert.ok(Math.abs(originalRate - 1.5) < .001, 'the split clip keeps its playback rate');
  await evaluate("(() => { const input=document.querySelector('#clipRate'); input.focus(); input.value='1.25'; input.dispatchEvent(new Event('input',{bubbles:true})); })()");
  await waitUntil(() => evaluate("Number(document.querySelector('#clipRate')?.value)"), value => Math.abs(value - 1.25) < .001, 'playback rate edit');
  await evaluate("document.querySelector('#undoBtn').click()");
  await waitUntil(() => evaluate("Number(document.querySelector('#clipRate')?.value)"), value => Math.abs(value - 1.5) < .001, 'undo restores playback rate');
  await evaluate("document.querySelector('#redoBtn').click()");
  await waitUntil(() => evaluate("Number(document.querySelector('#clipRate')?.value)"), value => Math.abs(value - 1.25) < .001, 'redo restores playback rate');

  await evaluate("(() => { const input=document.querySelector('#clipOffset'); input.focus(); input.value='0.5'; input.dispatchEvent(new Event('change',{bubbles:true})); })()");
  await waitUntil(() => evaluate("Number(document.querySelector('#clipOffset')?.value)"), value => Math.abs(value - .5) < .001, 'source offset edit');
  await evaluate("document.querySelector('#undoBtn').click()");
  await waitUntil(() => evaluate("Number(document.querySelector('#clipOffset')?.value)"), value => Math.abs(value - .94) < .02, 'undo restores source offset');
  await evaluate("document.querySelector('#redoBtn').click()");
  await waitUntil(() => evaluate("Number(document.querySelector('#clipOffset')?.value)"), value => Math.abs(value - .5) < .001, 'redo restores source offset');

  const clipWidthBeforeTrim = await evaluate("document.querySelectorAll('.track-lane .clip')[1].style.width");
  const trimRightPoint = await evaluate("(() => { const rect=document.querySelectorAll('.track-lane .clip')[1].getBoundingClientRect(); return {x:rect.right-3,y:rect.top+rect.height/2}; })()");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: trimRightPoint.x, y: trimRightPoint.y, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: trimRightPoint.x - 6, y: trimRightPoint.y, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: trimRightPoint.x - 6, y: trimRightPoint.y, button: 'left' });
  const trimmedWidth = await waitUntil(
    () => evaluate("document.querySelectorAll('.track-lane .clip')[1]?.style.width"),
    value => value && value !== clipWidthBeforeTrim,
    'trim the audio clip end',
  );
  await evaluate("document.querySelector('#undoBtn').click()");
  await waitUntil(() => evaluate("document.querySelectorAll('.track-lane .clip')[1]?.style.width"), value => value === clipWidthBeforeTrim, 'undo restores clip end trim');
  await evaluate("document.querySelector('#redoBtn').click()");
  await waitUntil(() => evaluate("document.querySelectorAll('.track-lane .clip')[1]?.style.width"), value => value === trimmedWidth, 'redo restores clip end trim');

  const clipLeftBeforeTrim = await evaluate("document.querySelectorAll('.track-lane .clip')[1].style.left");
  const trimLeftPoint = await evaluate("(() => { const rect=document.querySelectorAll('.track-lane .clip')[1].getBoundingClientRect(); return {x:rect.left+3,y:rect.top+rect.height/2}; })()");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: trimLeftPoint.x, y: trimLeftPoint.y, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: trimLeftPoint.x + 6, y: trimLeftPoint.y, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: trimLeftPoint.x + 6, y: trimLeftPoint.y, button: 'left' });
  const trimmedLeft = await waitUntil(
    () => evaluate("document.querySelectorAll('.track-lane .clip')[1]?.style.left"),
    value => value && value !== clipLeftBeforeTrim,
    'trim the audio clip start',
  );
  const trimmedSourceOffset = await waitUntil(
    () => evaluate("Number(document.querySelector('#clipOffset')?.value)"),
    value => Math.abs(value - .5) > .001,
    'left trim advances the source offset',
  );
  assert.ok(Number.isFinite(trimmedSourceOffset));
  await evaluate("document.querySelector('#undoBtn').click()");
  await waitUntil(() => evaluate("document.querySelectorAll('.track-lane .clip')[1]?.style.left"), value => value === clipLeftBeforeTrim, 'undo restores clip start trim');
  await waitUntil(() => evaluate("Number(document.querySelector('#clipOffset')?.value)"), value => Math.abs(value - .5) < .001, 'undo restores source offset after left trim');
  await evaluate("document.querySelector('#redoBtn').click()");
  await waitUntil(() => evaluate("document.querySelectorAll('.track-lane .clip')[1]?.style.left"), value => value === trimmedLeft, 'redo restores clip start trim');
  await waitUntil(() => evaluate("Number(document.querySelector('#clipOffset')?.value)"), value => Math.abs(value - trimmedSourceOffset) < .001, 'redo restores source offset after left trim');
  const originalRightLeft = await evaluate("document.querySelectorAll('.track-lane .clip')[1].style.left");
  const dragPoint = await evaluate("(() => { const rect=document.querySelectorAll('.track-lane .clip')[1].getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}; })()");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragPoint.x, y: dragPoint.y, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragPoint.x + 60, y: dragPoint.y, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragPoint.x + 60, y: dragPoint.y, button: 'left' });
  const movedRightLeft = await waitUntil(
    () => evaluate("document.querySelectorAll('.track-lane .clip')[1]?.style.left"),
    value => value && value !== originalRightLeft,
    'moving an Arrangement clip',
  );
  await evaluate("document.querySelector('#undoBtn').click()");
  await waitUntil(
    () => evaluate("document.querySelectorAll('.track-lane .clip')[1]?.style.left"),
    value => value === originalRightLeft,
    'undo restores the clip start',
  );
  await evaluate("document.querySelector('#redoBtn').click()");
  await waitUntil(
    () => evaluate("document.querySelectorAll('.track-lane .clip')[1]?.style.left"),
    value => value === movedRightLeft,
    'redo restores the moved clip start',
  );
  const fadeIn = await evaluate("document.querySelector('#clipFadeIn')?.value");
  assert.ok(fadeIn !== undefined, 'the selected audio clip exposes fade controls');
  await evaluate("(() => { const input=document.querySelector('#clipFadeIn'); input.focus(); input.value='0.12'; input.dispatchEvent(new Event('change',{bubbles:true})); })()");
  await waitUntil(() => evaluate("Number(document.querySelector('#clipFadeIn')?.value)"), value => Math.abs(value - .12) < .001, 'fade-in edit');
  await evaluate("document.querySelector('#undoBtn').click()");
  await waitUntil(() => evaluate("Number(document.querySelector('#clipFadeIn')?.value)"), value => Math.abs(value) < .001, 'undo restores fade-in');
  await evaluate("document.querySelector('#redoBtn').click()");
  await waitUntil(() => evaluate("Number(document.querySelector('#clipFadeIn')?.value)"), value => Math.abs(value - .12) < .001, 'redo restores fade-in');
  assert.deepEqual(exceptions, [], 'clip move and fade history must not throw renderer exceptions');
  await evaluate("document.querySelector('#createClipGainEnvelope').click()");
  await waitUntil(() => evaluate("Boolean(document.querySelector('#addClipGainEnvelopePoint'))"), Boolean, 'clip gain envelope editor');
  const envelopeRulerPoint = await evaluate("(() => { const ruler=document.querySelector('#barRuler').getBoundingClientRect(); const clip=document.querySelectorAll('.track-lane .clip')[1].getBoundingClientRect(); return {x:clip.left+clip.width/2,y:ruler.top+ruler.height/2}; })()");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: envelopeRulerPoint.x, y: envelopeRulerPoint.y, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: envelopeRulerPoint.x, y: envelopeRulerPoint.y, button: 'left' });
  await evaluate("document.querySelector('#addClipGainEnvelopePoint').click()");
  await waitUntil(() => evaluate("document.querySelectorAll('[data-clip-gain-value]').length"), count => count === 3, 'clip gain envelope point creation');
  await evaluate("(() => { const input=document.querySelector('[data-clip-gain-value=\"1\"]'); input.focus(); input.value='0.3'; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); })()");
  await waitUntil(() => evaluate("document.querySelector('[data-clip-gain-value=\"1\"]')?.value"), value => Math.abs(Number(value) - .3) < .001, 'clip gain point edit');
  assert.equal(await evaluate("Boolean(document.querySelector('.clip-gain-envelope-curve path'))"), true, 'Arrangement draws the gain curve over the waveform');
  await evaluate("document.querySelector('#undoBtn').click()");
  await waitUntil(() => evaluate("document.querySelector('[data-clip-gain-value=\"1\"]')?.value"), value => Math.abs(Number(value) - 1) < .001, 'undo restores the clip gain point');
  await evaluate("document.querySelector('#redoBtn').click()");
  await waitUntil(() => evaluate("document.querySelector('[data-clip-gain-value=\"1\"]')?.value"), value => Math.abs(Number(value) - .3) < .001, 'redo restores the clip gain point');
  assert.deepEqual(exceptions, [], 'clip gain editing must not throw renderer exceptions');
  const fixtureFrames = await evaluate(`(() => {
    const sr=48000,frames=sr*2,header=new Uint8Array(44),h=new DataView(header.buffer);
    const write=(o,s)=>[...s].forEach((c,i)=>h.setUint8(o+i,c.charCodeAt(0)));
    write(0,'RIFF');h.setUint32(4,36+frames*2,true);write(8,'WAVE');write(12,'fmt ');
    h.setUint32(16,16,true);h.setUint16(20,1,true);h.setUint16(22,1,true);h.setUint32(24,sr,true);
    h.setUint32(28,sr*2,true);h.setUint16(32,2,true);h.setUint16(34,16,true);write(36,'data');h.setUint32(40,frames*2,true);
    const pcm=new Uint8Array(frames*2),v=new DataView(pcm.buffer);
    for(const[at,amp]of[[.3,.6],[1,.4]]){const first=Math.round(at*sr);for(let i=first;i<first+2880;i++){const t=(i-first)/sr;v.setInt16(i*2,Math.round(amp*Math.sin(2*Math.PI*440*t)*Math.exp(-t/.018)*32767),true);}}
    const file=new File([header,pcm],'qa-transients.wav',{type:'audio/wav'}),dt=new DataTransfer();dt.items.add(file);
    const input=document.querySelector('#audioFiles');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return frames;
  })()`);
  assert.equal(fixtureFrames,96000);
  await waitUntil(()=>evaluate("document.querySelectorAll('.track-lane .clip').length"),n=>n===3,'transient PCM clip import');
  const clickClip=async index=>{
    const p=await evaluate(`(()=>{const r=document.querySelectorAll('.track-lane .clip')[${index}].getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left'});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left'});
  };
  const selectClipNamed=async name=>evaluate("(()=>{const clip=[...document.querySelectorAll('.track-lane .clip')].find(item=>item.querySelector('.clip-header span')?.textContent==="+JSON.stringify(name)+");if(!clip)return false;clip.click();return true;})()");
  await clickClip(2);
  assert.equal(await waitUntil(()=>evaluate("Boolean(document.querySelector('#sliceTransientsBtn') && !document.querySelector('#sliceTransientsBtn').disabled)"),Boolean,'transient slicer'),true);
  await evaluate("document.querySelector('#sliceTransientsBtn').click()");
  await waitUntil(()=>evaluate("document.querySelectorAll('.track-lane .clip').length"),n=>n===5,'two detected cuts');
  assert.equal(await selectClipNamed('qa-transients · 2'),true,'find the second named slice');
  const offset2=await waitUntil(()=>evaluate("Number(document.querySelector('#clipOffset')?.value)"),v=>Math.abs(v-.3)<.02,'second slice offset');
  assert.equal(await selectClipNamed('qa-transients · 3'),true,'find the third named slice');
  const offset3=await waitUntil(()=>evaluate("Number(document.querySelector('#clipOffset')?.value)"),v=>Math.abs(v-1)<.02,'third slice offset');
  assert.ok(Math.abs(offset2-.3)<.02&&Math.abs(offset3-1)<.02);
  await evaluate("document.querySelector('#undoBtn').click()");
  await waitUntil(()=>evaluate("document.querySelectorAll('.track-lane .clip').length"),n=>n===3,'undo of transient slicing');
  await evaluate("document.querySelector('#redoBtn').click()");
  await waitUntil(()=>evaluate("document.querySelectorAll('.track-lane .clip').length"),n=>n===5,'redo of transient slicing');
  assert.deepEqual(exceptions,[], 'transient slicing and history must not throw renderer exceptions');

  const markerAdded = await evaluate("(() => { const previous=window.prompt; window.prompt=()=> 'QA Marker'; document.querySelector('#addMarkerBtn').click(); window.prompt=previous; return document.querySelectorAll('.marker-line').length; })()");
  assert.equal(markerAdded,1,'the marker is visible in Arrangement');
  await evaluate(`(() => {
    window.__qaSavedProject=null;
    const create=URL.createObjectURL, click=HTMLAnchorElement.prototype.click;
    URL.createObjectURL=blob=>{window.__qaSavedProject=blob;return 'blob:qa-project';};
    HTMLAnchorElement.prototype.click=()=>{};
    document.querySelector('#saveProjectBtn').click();
    URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;
  })()`);
  const savedState = await evaluate("window.__qaSavedProject.text().then(text => { const project=JSON.parse(text); const track=project.tracks.find(item=>item.effects?.compressor);return { clips:project.tracks.reduce((sum,item)=>sum+item.clips.length,0), markers:project.markers.map(marker=>marker.name), compressor:track?{enabled:track.effects.compressor,...track.compressorSettings}:null, limiter:track?{enabled:track.effects.limiter,...track.limiterSettings}:null }; })");
  assert.deepEqual(savedState,{clips:5,markers:['QA Marker'],compressor:{enabled:true,thresholdDb:-24,ratio:6,attackMs:5,releaseMs:240,makeupDb:2},limiter:{enabled:true,ceilingDb:-3.5,releaseMs:125}},'the .sonora file contains slices, marker, compressor, and limiter settings');
  await evaluate("(() => { const previous=window.confirm; window.confirm=()=>true; document.querySelector('#newProjectBtn').click(); window.confirm=previous; })()");
  await waitUntil(()=>evaluate("document.querySelectorAll('.track-lane .clip').length"),count=>count===0,'new empty project before reload');
  const loaded = await evaluate(`(() => { const file=new File([window.__qaSavedProject],'qa-roundtrip.sonora',{type:'application/json'}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('#projectFile');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true; })()`);
  assert.equal(loaded,true);
  await waitUntil(()=>evaluate("document.querySelectorAll('.track-lane .clip').length"),count=>count===5,'project audio and slices after reopening');
  await waitUntil(()=>evaluate("document.querySelector('.marker-line span')?.textContent"),name=>name==='QA Marker','marker after reopening');
  assert.equal(await waitUntil(()=>evaluate("document.querySelector('[data-inspector-effect=compressor]')?.getAttribute('aria-pressed')"),value=>value==='true','compressor after reopening'),'true');
  assert.equal(await evaluate("Number(document.querySelector('#compressorRatio').value)"),6,'compressor controls after reopening');
  assert.equal(await waitUntil(()=>evaluate("document.querySelector('[data-inspector-effect=limiter]')?.getAttribute('aria-pressed')"),value=>value==='true','limiter after reopening'),'true');
  assert.deepEqual(await evaluate("(()=>({ceilingDb:Number(document.querySelector('#limiterCeiling').value),releaseMs:Number(document.querySelector('#limiterRelease').value)}))()"),{ceilingDb:-3.5,releaseMs:125},'limiter controls after reopening');
  assert.deepEqual(exceptions,[], 'markers and project save/open must not throw renderer exceptions');
  await evaluate(`(() => {
    window.__qaWavBlob=null;window.__qaWavDownload=null;
    window.__qaOriginalCreate=URL.createObjectURL;window.__qaOriginalAnchorClick=HTMLAnchorElement.prototype.click;
    URL.createObjectURL=blob=>{if(blob.type==='audio/wav')window.__qaWavBlob=blob;return 'blob:qa-export';};
    HTMLAnchorElement.prototype.click=function(){if(this.download?.toLowerCase().endsWith('.wav'))window.__qaWavDownload=this.download;};
    document.querySelector('#exportBtn').click();return true;
  })()`);
  assert.equal(await waitUntil(()=>evaluate("Boolean(window.__qaWavBlob && window.__qaWavDownload)"),Boolean,'rendered WAV export'),true);
  await evaluate(`(() => { URL.createObjectURL=window.__qaOriginalCreate;HTMLAnchorElement.prototype.click=window.__qaOriginalAnchorClick; })()`);
  const wav = await evaluate(`window.__qaWavBlob.arrayBuffer().then(buffer=>{
    const view=new DataView(buffer),text=(offset,length)=>String.fromCharCode(...new Uint8Array(buffer,offset,length));
    return {type:window.__qaWavBlob.type,filename:window.__qaWavDownload,size:buffer.byteLength,riff:text(0,4),riffSize:view.getUint32(4,true),wave:text(8,4),format:view.getUint16(20,true),channels:view.getUint16(22,true),sampleRate:view.getUint32(24,true),byteRate:view.getUint32(28,true),blockAlign:view.getUint16(32,true),bitsPerSample:view.getUint16(34,true),data:text(36,4),dataSize:view.getUint32(40,true)};
  })`);
  assert.equal(wav.type,'audio/wav');assert.ok(wav.filename.toLowerCase().endsWith('.wav'));
  assert.deepEqual({riff:wav.riff,wave:wav.wave,format:wav.format,channels:wav.channels,sampleRate:wav.sampleRate,byteRate:wav.byteRate,blockAlign:wav.blockAlign,bitsPerSample:wav.bitsPerSample,data:wav.data},{riff:'RIFF',wave:'WAVE',format:1,channels:2,sampleRate:44100,byteRate:176400,blockAlign:4,bitsPerSample:16,data:'data'});
  assert.ok(wav.dataSize>0&&wav.dataSize%4===0,'stereo PCM data has complete frames');
  assert.equal(wav.size,44+wav.dataSize,'WAV data length matches its RIFF payload');
  assert.equal(wav.riffSize,wav.size-8,'RIFF length matches the encoded file');
  assert.deepEqual(exceptions,[], 'WAV export must not throw renderer exceptions');
  const rulerSelection = await evaluate(`(() => {
    const ruler=document.querySelector('#barRuler'),bounds=ruler.getBoundingClientRect();
    const barWidth=Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar'));
    return {start:{x:bounds.left+barWidth*.5,y:bounds.top+bounds.height/2},end:{x:bounds.left+barWidth*1.5,y:bounds.top+bounds.height/2},barWidth};
  })()`);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:rulerSelection.start.x,y:rulerSelection.start.y,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rulerSelection.end.x,y:rulerSelection.end.y,button:'left',buttons:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rulerSelection.end.x,y:rulerSelection.end.y,button:'left',clickCount:1});
  const selectedRange=await waitUntil(()=>evaluate(`(()=>{const button=document.querySelector('#loopBtn'),region=document.querySelector('#loopRegion');return {label:button.getAttribute('aria-label'),left:Number.parseFloat(region.style.left),width:Number.parseFloat(region.style.width)}})()`),value=>value.label?.includes('1:3–2:3'),'Arrangement A–B range selection');
  assert.ok(Math.abs(selectedRange.left-rulerSelection.barWidth/2)<1,'range starts at beat 2');
  assert.ok(Math.abs(selectedRange.width-rulerSelection.barWidth)<1,'range spans four beats');
  await evaluate("document.querySelector('#loopBtn').click()");
  assert.deepEqual(await evaluate("(()=>({pressed:document.querySelector('#loopBtn').getAttribute('aria-pressed'),active:document.querySelector('#loopRegion').classList.contains('is-looping')}))()"),{pressed:'true',active:true},'selected range can be enabled as the playback loop');
  assert.deepEqual(exceptions,[], 'Arrangement range selection must not throw renderer exceptions');
  const largeProject = JSON.parse(await evaluate("window.__qaSavedProject.text()"));
  const audioTrack = largeProject.tracks.find(track => track.clips?.some(clip => !clip.kind));
  assert.ok(audioTrack, 'saved project contains an audio track for the large-session fixture');
  const clipTemplate = structuredClone(audioTrack.clips.find(clip => !clip.kind));
  const previousClipCount = largeProject.tracks.reduce((sum, track) => sum + track.clips.length, 0);
  const previousAudioClipCount = audioTrack.clips.length;
  const largeClipCount = 128;
  const clipSpacing = clipTemplate.lengthBeats + 1;
  audioTrack.clips = Array.from({ length: largeClipCount }, (_, index) => ({
    ...structuredClone(clipTemplate),
    id: `qa-large-${index}`,
    startBeat: index * clipSpacing,
    offsetSec: 0,
    trimEndSec: 0,
  }));
  const expectedLargeProjectClipCount = previousClipCount - previousAudioClipCount + largeClipCount;
  const largeProjectText = JSON.stringify(largeProject);
  await evaluate("(() => { const previous=window.confirm; window.confirm=()=>true; document.querySelector('#newProjectBtn').click(); window.confirm=previous; })()");
  await waitUntil(() => evaluate("document.querySelectorAll('.track-lane .clip').length"), count => count === 0, 'empty Arrangement before loading the large session');
  await evaluate(`(() => { const file=new File([${JSON.stringify(largeProjectText)}],'qa-large-arrangement.sonora',{type:'application/json'}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('#projectFile');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true; })()`);
  await waitUntil(
    () => evaluate("document.querySelectorAll('.track-lane .clip').length"),
    count => count === expectedLargeProjectClipCount,
    'large Arrangement project load',
  );
  const largeDefault = await evaluate("(() => { const clip=document.querySelector('[data-clip=\"qa-large-127\"]'); return {left:parseFloat(clip.style.left),width:parseFloat(clip.style.width)}; })()");
  await evaluate("(() => { const input=document.querySelector('#zoomInput'); input.value='180'; input.dispatchEvent(new Event('input',{bubbles:true})); })()");
  const largeZoomed = await evaluate("(() => { const clip=document.querySelector('[data-clip=\"qa-large-127\"]'); return {left:parseFloat(clip.style.left),width:parseFloat(clip.style.width)}; })()");
  assert.ok(largeZoomed.left > largeDefault.left && largeZoomed.width > largeDefault.width, 'large Arrangement clips retain beat geometry at high zoom');
  const largeTimelineScroll = await evaluate("(() => { const scroll=document.querySelector('#timelineScroll'),clip=document.querySelector('[data-clip=\\\"qa-large-127\\\"]'); scroll.scrollLeft=Math.max(0,parseFloat(clip.style.left)-80); const rect=clip.getBoundingClientRect(),viewport=scroll.getBoundingClientRect(); return {scrollLeft:scroll.scrollLeft,visible:rect.right>viewport.left&&rect.left<viewport.right}; })()");
  assert.ok(largeTimelineScroll.scrollLeft > 0 && largeTimelineScroll.visible, 'horizontal scroll brings the final clip into view');
  await evaluate("document.querySelector('[data-clip=\\\"qa-large-127\\\"]').click()");
  assert.equal(await waitUntil(() => evaluate("document.querySelector('[data-clip=\\\"qa-large-127\\\"]')?.classList.contains('selected')"), Boolean, 'select a clip at the end of a large Arrangement'), true);
  assert.deepEqual(exceptions, [], 'large Arrangement rendering, zoom, scroll and selection must not throw renderer exceptions');
  const samplerProject = structuredClone(largeProject);
  const samplerAsset = samplerProject.assets.find(asset => asset.wav);
  assert.ok(samplerAsset, 'sampler smoke fixture has an imported WAV asset');
  samplerProject.tracks.push({
    id: 'qa-sampler-track', name: 'QA sampler', type: 'instrument', instrument: 'sampler',
    samplerAssetId: samplerAsset.id, samplerRootNote: 60, volume: .8, pan: 0, mute: false, solo: false,
    clips: [{ id: 'qa-sampler-midi', name: 'Sampler MIDI', kind: 'midi', startBeat: 0, lengthBeats: 4,
      notes: [{ beat: 0, length: 1, note: 60, velocity: .8 }, { beat: 1, length: 1, note: 72, velocity: .8 }] }],
  });
  samplerProject.selectedTrackId = 'qa-sampler-track';
  const samplerProjectText = JSON.stringify(samplerProject);
  await evaluate("(() => { const previous=window.confirm; window.confirm=()=>true; document.querySelector('#newProjectBtn').click(); window.confirm=previous; })()");
  await waitUntil(() => evaluate("document.querySelectorAll('.track-lane .clip').length"), count => count === 0, 'empty Arrangement before loading sampler session');
  await evaluate(`(() => { const file=new File([${JSON.stringify(samplerProjectText)}],'qa-sampler.sonora',{type:'application/json'}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('#projectFile');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true; })()`);
  await waitUntil(() => evaluate("document.querySelector('#inspectorSynthInstrument')?.value"), value => value === 'sampler', 'sampler project selection');
  await evaluate("document.querySelector('#inspectorOpenEditorBtn').click()");
  const samplerEditor = await waitUntil(() => evaluate("(()=>({asset:document.querySelector('#samplerAsset')?.value,root:document.querySelector('#samplerRootNote')?.value,option:document.querySelector('#samplerAsset option:checked')?.textContent}))()"), value => value.asset === samplerAsset.id, 'sampler sample controls');
  assert.equal(samplerEditor.root, '60', 'sampler editor restores its MIDI root key');
  assert.ok(samplerEditor.option.length > 0, 'sampler editor shows the imported WAV name');
  assert.deepEqual(exceptions, [], 'sampler project load and editor must not throw renderer exceptions');
  const drumProject = structuredClone(largeProject);
  drumProject.tracks.forEach(track => { track.clips = []; });
  drumProject.tracks.push({
    id: 'qa-drum-track', name: 'QA drums', type: 'drums', volume: .8, pan: 0, mute: false, solo: false,
    clips: [{ id: 'qa-drum-pattern', name: 'QA pattern', kind: 'drums', startBeat: 0, lengthBeats: 4,
      steps: [{ name: 'Kick', kind: 'kick', velocity: .8, probability: 1, ratchets: 1, hits: [0, 4, 8, 12] }] }],
  });
  drumProject.selectedTrackId = 'qa-drum-track';
  const drumProjectText = JSON.stringify(drumProject);
  await evaluate("(() => { const previous=window.confirm; window.confirm=()=>true; document.querySelector('#newProjectBtn').click(); window.confirm=previous; })()");
  await waitUntil(() => evaluate("document.querySelectorAll('.track-lane .clip').length"), count => count === 0, 'empty Arrangement before loading step sequencer session');
  await evaluate(`(() => { const file=new File([${JSON.stringify(drumProjectText)}],'qa-step-sequencer.sonora',{type:'application/json'}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('#projectFile');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true; })()`);
  await waitUntil(() => evaluate("document.querySelector('#inspectorOpenEditorBtn')?.textContent"), text => text?.includes('редактор'), 'step sequencer track inspector');
  await evaluate("document.querySelector('#inspectorOpenEditorBtn').click()");
  await waitUntil(() => evaluate("Boolean(document.querySelector('.step-probability') && document.querySelector('.step-ratchets'))"), Boolean, 'probability and ratchet controls');
  const stepControls = await evaluate("(() => { const chance=document.querySelector('.step-probability'),repeat=document.querySelector('.step-ratchets'); chance.value='0.55';chance.dispatchEvent(new Event('input',{bubbles:true}));chance.dispatchEvent(new Event('change',{bubbles:true}));repeat.value='4';repeat.dispatchEvent(new Event('change',{bubbles:true}));return {chance:document.querySelector('.step-probability-value').textContent,repeat:repeat.value+'×'}; })()");
  assert.deepEqual(stepControls, { chance: '55%', repeat: '4×' }, 'step probability and ratchet controls update their displayed values');
  assert.deepEqual(exceptions, [], 'step sequencer rendering and controls must not throw renderer exceptions');
  console.log(`Electron UI smoke passed: sampler editor, probability/ratchet controls, 128-clip Arrangement, zoom, spectrum analyzer, EQ, compressor, limiter, split/slicing, undo/redo, project round-trip, WAV export and loop selection`);
} finally {
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  if (child.exitCode === null) {
    const exited = new Promise(resolveExit => child.once('exit', resolveExit));
    const stopped = await Promise.race([exited.then(() => true), delay(3_000).then(() => false)]);
    if (!stopped && child.exitCode === null) {
      child.kill();
      await Promise.race([exited, delay(2_000)]);
    }
  }
}
