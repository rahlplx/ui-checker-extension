/**
 * UI Checker — Elements Sidebar Pane
 *
 * Fix #10: Clone Component button added — uses $0 naturally since sidebar
 * has the same DevTools context as the panel. This is the most ergonomic
 * placement: user selects element → sidebar shows findings for it → clicks
 * Clone Component → HTML+styles copied immediately without switching panels.
 */

// ── Debug logger ──────────────────────────────────────────────────────────────
const LOG = (...a) => console.debug('[uichecker:sidebar]', ...a);

// ── Theme ─────────────────────────────────────────────────────────────────────
if (chrome.devtools.panels.themeName === 'dark') {
  document.documentElement.classList.add('theme-dark');
}

const tabId   = chrome.devtools.inspectedWindow.tabId;
const content = document.getElementById('sidebar-content');
const actions = document.getElementById('sidebar-actions');
const cloneBtn  = document.getElementById('sidebar-clone-btn');
const cloneToast = document.getElementById('sidebar-clone-toast');

let currentFindings = [];
LOG('sidebar init for tab', tabId);

// ── Port (auto-reconnecting) ─────────────────────────────────────────────────
let port = null;
function getPort() {
  if (port) return port;
  LOG('connecting port');
  port = chrome.runtime.connect({ name: `uichecker-sidebar-${tabId}` });
  port.onMessage.addListener((msg) => {
    LOG('port message', msg.action);
    if (msg.action === 'findings' || msg.action === 'state') {
      currentFindings = msg.findings || [];
      refreshForCurrentSelection();
    }
  });
  port.onDisconnect.addListener(() => { LOG('port disconnected'); port = null; });
  return port;
}
getPort();

// ── Selection change listener ─────────────────────────────────────────────────
chrome.devtools.panels.elements.onSelectionChanged.addListener(() => {
  LOG('selection changed');
  refreshForCurrentSelection();
});

// ── Refresh for current $0 ────────────────────────────────────────────────────
function refreshForCurrentSelection() {
  if (!currentFindings.length) {
    renderEmpty('No findings on this page yet.');
    setActionsVisible(false);
    return;
  }

  const selectors = currentFindings
    .filter(item => !item.isPageLevel && !item.isHidden)
    .map(item => item.selector);

  if (!selectors.length) {
    renderEmpty('No element-level findings on this page.');
    setActionsVisible(false);
    return;
  }

  // Match selectors against $0 in page context
  const code = `(function(){
    var sels=${JSON.stringify(selectors)}, matched=[];
    for(var i=0;i<sels.length;i++){
      try{ if(document.querySelector(sels[i])===$0) matched.push(sels[i]); }catch(e){}
    }
    return matched;
  })()`;

  chrome.devtools.inspectedWindow.eval(code, (matched, exInfo) => {
    if (exInfo) { LOG('eval error', exInfo.value); return; }
    if (!matched?.length) {
      renderNoFindings();
      setActionsVisible(true);  // Clone Component still available even for clean elements
      return;
    }
    const items = currentFindings.filter(item => matched.includes(item.selector));
    render(items);
    setActionsVisible(true);
  });
}

// ── Render helpers ────────────────────────────────────────────────────────────
function setActionsVisible(v) {
  actions.style.display = v ? '' : 'none';
}

function renderEmpty(text) {
  setActionsVisible(false);
  content.innerHTML = `<div class="state">${escapeHtml(text)}</div>`;
}

function renderNoFindings() {
  content.innerHTML = `<div class="state"><strong>Clean.</strong> No anti-patterns on this element.</div>`;
}

function render(items) {
  const html = [];
  for (const item of items) {
    for (const f of item.findings) {
      const isSlop = f.category === 'slop';
      html.push(`
        <div class="finding">
          <div class="finding-header">
            <span class="finding-name">${isSlop ? '<span class="marker">✦</span>' : ''}${escapeHtml(f.name)}</span>
            <span class="finding-kind">${isSlop ? 'AI tell' : 'Quality'}</span>
          </div>
          <div class="finding-detail">${escapeHtml(f.detail)}</div>
          <div class="finding-description">${escapeHtml(f.description)}</div>
        </div>`);
    }
  }
  content.innerHTML = html.join('');
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ── Clone Component (sidebar) ─────────────────────────────────────────────────
// Fix #10: Natural placement — user has already selected the element ($0),
// sidebar is already showing findings for it. One click to clone.
let _toastTimer = null;
function showSidebarToast(msg, state = '') {
  cloneToast.textContent = msg;
  cloneToast.className   = `sidebar-clone-toast visible ${state}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { cloneToast.className = 'sidebar-clone-toast'; }, 3500);
}

cloneBtn.addEventListener('click', () => {
  LOG('clone-component from sidebar');
  cloneBtn.disabled = true;

  chrome.devtools.inspectedWindow.eval(
    `(function(){
      var el=$0;
      if(!el||el===document.documentElement||el===document.body){
        return{ok:false,reason:'no-element'};
      }
      var PROPS=['display','position','top','right','bottom','left',
        'width','height','min-width','min-height','max-width','max-height',
        'padding','padding-top','padding-right','padding-bottom','padding-left',
        'margin','margin-top','margin-right','margin-bottom','margin-left',
        'flex','flex-direction','flex-wrap','align-items','justify-content','gap',
        'grid','grid-template-columns','grid-template-rows',
        'background','background-color','background-image',
        'color','font-family','font-size','font-weight','line-height',
        'letter-spacing','text-align','text-transform',
        'border','border-radius','box-shadow','opacity','overflow',
        'transform','transition','z-index','cursor'];
      try{
        var cs=window.getComputedStyle(el);
        var styles=PROPS.map(function(p){return p+':'+cs.getPropertyValue(p);}).join(';');
        var clone=el.cloneNode(true);
        clone.querySelectorAll('.uichecker-overlay,.uichecker-label')
             .forEach(function(n){n.remove();});
        var ex=clone.getAttribute('style')||'';
        clone.setAttribute('style',(ex?ex+';':'')+styles);
        return{ok:true,html:clone.outerHTML,tag:el.tagName.toLowerCase()};
      }catch(e){
        return{ok:false,reason:'exception',error:e.message};
      }
    })()`,
    (result, exInfo) => {
      cloneBtn.disabled = false;

      if (exInfo) {
        LOG('clone eval exception', exInfo.value);
        cloneBtn.className = 'sidebar-clone-btn state-error';
        showSidebarToast('Eval error: ' + exInfo.value, 'error');
        setTimeout(() => { cloneBtn.className = 'sidebar-clone-btn'; }, 2000);
        return;
      }

      if (!result?.ok) {
        if (result?.reason === 'no-element') {
          showSidebarToast('Select an element in the Elements panel first');
        } else {
          LOG('clone failed', result?.error);
          showSidebarToast('Failed: ' + (result?.error || result?.reason));
        }
        cloneBtn.className = 'sidebar-clone-btn state-error';
        setTimeout(() => { cloneBtn.className = 'sidebar-clone-btn'; }, 2000);
        return;
      }

      navigator.clipboard.writeText(result.html).then(() => {
        LOG('clone-component ok', result.tag, result.html.length, 'chars');
        cloneBtn.className = 'sidebar-clone-btn state-ok';
        showSidebarToast(`<${result.tag}> + styles copied (${result.html.length.toLocaleString()} chars)`);
        setTimeout(() => { cloneBtn.className = 'sidebar-clone-btn'; }, 2000);
      }).catch(err => {
        LOG('clipboard write failed', err.message);
        showSidebarToast('Clipboard write failed');
        cloneBtn.className = 'sidebar-clone-btn state-error';
        setTimeout(() => { cloneBtn.className = 'sidebar-clone-btn'; }, 2000);
      });
    }
  );
});
