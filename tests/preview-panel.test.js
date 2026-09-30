const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const panelState = require('../src/panel-state.js');
const panelStyles = readFileSync(path.join(__dirname, '..', 'plugin', 'styles.css'), 'utf8');
const panelMainSource = readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

let preview;
test.before(async () => {
  preview = await import('../scripts/preview-panel.mjs');
});

test('panel preview covers every production top-level state', () => {
  const expectedModes = {
    disconnected: 'disconnected',
    unsaved: 'unsaved',
    'no-sequence': 'no-sequence',
    ready: 'ready',
    starting: 'starting',
    listening: 'listening',
    paused: 'paused',
    scanning: 'scanning',
    processing: 'processing',
    loading: 'loading',
    error: 'error',
  };

  for (const [state, expectedMode] of Object.entries(expectedModes)) {
    const scenario = preview.createPreviewScenario(state, 'rename');
    assert.equal(panelState.derivePanelState(scenario.input).mode, expectedMode, state);
  }
});

test('panel preview allows every real processing stage and rejects unknown values', () => {
  for (const stage of panelState.PIPELINE_STAGES) {
    assert.equal(preview.createPreviewScenario('processing', stage).job.stage, stage);
  }
  assert.equal(preview.normalizePreviewState('not-real'), 'ready');
  assert.equal(preview.normalizePreviewStage('not-real'), 'relink');
});

test('panel preview presents the project-level globally unique recording ID format', async () => {
  const html = await preview.renderIndex('processing', 'rename');
  assert.match(html, /项目名 \+ UUID/);
  assert.match(html, /318最终版-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77\.wav/);
  assert.match(html, /[a-f0-9]{32}\.wav/);
  assert.doesNotMatch(html, /总序号/);
  assert.doesNotMatch(html, /总序号\s*·\s*时间/);
  assert.doesNotMatch(html, /20260902-145830/);
  assert.doesNotMatch(html, /318最终版-A02-003/);
  assert.doesNotMatch(html, /318最终版-000003/);
});

test('compact panel keeps common commands and puts full connection values behind an accessible disclosure', async () => {
  const html = await preview.renderIndex('ready', 'rename');
  assert.match(html, /扫描遗漏录音/);
  assert.match(html, /整理同名素材/);
  assert.match(html, /最终保存位置/);
  assert.match(html, /只用于发现 Premiere 原始录音，不会改变最终保存位置/);
  assert.match(html, /aria-controls="connectionDetails" aria-expanded="false"/);
  assert.match(html, /id="connectionDetails"[^>]* hidden/);
  assert.match(html, /id="projectName"/);
  assert.match(html, /id="sequenceName"/);
  assert.doesNotMatch(html, /guide-steps|guide-route|stateKicker/);
});

test('panel preview never presents the capture source as the final save location', async () => {
  const html = await preview.renderIndex('listening', 'rename');
  assert.equal(html.includes('"folderPath":"D:\\\\318最终版\\\\Adobe Premiere Pro Captured and Generated"'), true);
  assert.doesNotMatch(html, /Adobe Premiere Pro Captured Audio/);
  assert.match(html, /正在移入工程媒体目录并命名/);
});

test('panel puts processing details before connection details and retains the complete filename', async () => {
  const html = await preview.renderIndex('processing', 'relink');
  const stateIndex = html.indexOf('class="state-band"');
  const pipelineIndex = html.indexOf('class="pipeline-band"');
  const readinessIndex = html.indexOf('class="readiness-band"');

  assert.ok(stateIndex >= 0);
  assert.ok(pipelineIndex > stateIndex);
  assert.ok(readinessIndex > pipelineIndex);
  assert.match(html, /aria-controls="recordingDetails" aria-expanded="false"/);
  assert.match(html, /id="recordingDetails"[^>]* hidden/);
  assert.match(html, /链接并改片段/);
});

test('panel owns a definite visible vertical scrollport inside the UXP host', () => {
  assert.match(
    panelStyles,
    /html,\s*body\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
  );
  assert.match(
    panelStyles,
    /\.app-shell\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*display:\s*block;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*scroll;/s,
  );
  assert.match(panelStyles, /\.app-shell::\-webkit-scrollbar\s*\{[^}]*width:\s*10px;/s);
  assert.match(panelStyles, /\.app-shell::\-webkit-scrollbar-thumb\s*\{/);
});

test('panel sections stay in document flow instead of shrinking into each other', () => {
  const shellRule = panelStyles.match(/\.app-shell\s*\{([^}]*)\}/s);
  assert.ok(shellRule, 'app shell rule is missing');
  assert.match(shellRule[1], /display:\s*block/);
  assert.doesNotMatch(shellRule[1], /display:\s*flex|flex-direction|flex-shrink/);
});

test('manual disclosure remains available in every state instead of CSS forcing details closed', () => {
  assert.match(panelStyles, /\[hidden\]\s*\{[^}]*display:\s*none !important/);
  assert.doesNotMatch(panelStyles, /data-panel-state[^\n]*\.readiness-list/);
  assert.match(panelMainSource, /view\.mode !== previousMode/);
  assert.match(panelMainSource, /"recordingDetailsButton", onDisclosureClick/);
  assert.match(panelMainSource, /"connectionDetailsButton", onDisclosureClick/);
});

test('activity history stays bounded so logs cannot push the commands away', () => {
  assert.match(panelStyles, /\.activity-list\s*\{[^}]*max-height:\s*168px;[^}]*overflow-y:\s*auto;/s);
  assert.match(panelMainSource, /var LOG_LIMIT = 20;/);
});

test('production panel uses native controls and the flex/block subset', async () => {
  const html = await preview.renderIndex('listening', 'rename');
  assert.doesNotMatch(html, /<sp-(?:button|checkbox)\b/i);
  assert.match(html, /<button[^>]+id="stopButton"/i);
});

test('panel preview only accepts whitelisted URL state and stage values', () => {
  assert.equal(preview.normalizePreviewState('ready'), 'ready');
  assert.equal(preview.normalizePreviewState('ready<script>'), 'ready');
  assert.equal(preview.normalizePreviewState({ toString: () => 'processing' }), 'ready');
  assert.equal(preview.normalizePreviewStage('rename'), 'rename');
  assert.equal(preview.normalizePreviewStage('save'), 'relink');
  assert.equal(preview.normalizePreviewStage('relink<script>'), 'relink');
});

test('panel preview does not place untrusted query text in an inline script', async () => {
  const attack = '</script><script>globalThis.previewInjected=true</script>';
  const html = await preview.renderIndex(attack, attack);
  assert.doesNotMatch(html, /previewInjected/);
  assert.match(html, /src="src\/panel-state\.js"/);
  assert.doesNotMatch(html, /src="src\/main\.js"/);
});

test('panel preview serves the production state module used by the page', async (t) => {
  const server = preview.startPreviewServer(0);
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/src/panel-state.js`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /VoiceoverNamerPanelState/);
});
