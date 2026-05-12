/**
 * UI Checker v2 — Sandbox
 * Receives React/JSX code via postMessage, transpiles with Babel, renders with React 18.
 * This iframe runs in its own CSP context — eval() is allowed here.
 */

const root        = document.getElementById('root');
const errorDisplay = document.getElementById('error-display');
let reactRoot     = null;

function showError(msg) {
  errorDisplay.style.display = 'block';
  errorDisplay.textContent = msg;
  root.innerHTML = '';
}

function clearError() {
  errorDisplay.style.display = 'none';
}

function renderCode(rawCode) {
  clearError();

  // Strip markdown fences if Gemini included them
  let code = rawCode
    .replace(/^```(?:jsx?|tsx?|react)?\n?/im, '')
    .replace(/\n?```$/im, '')
    .trim();

  // If code is still streaming (incomplete), skip render
  if (!code || code.length < 20) return;

  try {
    // Transpile JSX → JS
    const transpiled = Babel.transform(code, {
      presets: ['react'],
      filename: 'component.jsx',
    }).code;

    // Inject React, ReactDOM into function scope
    // Wrap in IIFE that expects Component to be defined
    const wrapped = `
      const { useState, useEffect, useRef, useCallback, useMemo, useContext,
              createContext, Fragment } = React;
      ${transpiled}
      if (typeof Component !== 'undefined') {
        return Component;
      }
      // Try to find any exported default
      return null;
    `;

    // Execute in a controlled scope
    // eslint-disable-next-line no-new-func
    const factory = new Function('React', 'ReactDOM', wrapped);
    const Comp = factory(React, ReactDOM);

    if (!Comp) {
      showError('No default export named "Component" found in generated code.');
      return;
    }

    // Render
    if (!reactRoot) {
      reactRoot = ReactDOM.createRoot(root);
    }
    reactRoot.render(React.createElement(Comp));

  } catch (err) {
    showError(`Render error: ${err.message}`);
    console.error('[uichecker:sandbox]', err);
  }
}

// Listen for messages from Side Panel
window.addEventListener('message', (e) => {
  // Accept messages from the extension parent only
  if (e.data?.type === 'RENDER_CODE' && typeof e.data.code === 'string') {
    renderCode(e.data.code);
  }
  if (e.data?.type === 'CLEAR') {
    if (reactRoot) reactRoot.render(null);
    clearError();
  }
});

console.log('[uichecker:sandbox] ready');
