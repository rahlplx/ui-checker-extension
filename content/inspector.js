/**
 * UI Checker v2 — Inspector Content Script
 * Handles: hover inspector, DOM extraction for audit, SEO extraction, CSS filtering
 * Runs in isolated world. Communicates with SW via chrome.runtime.sendMessage.
 */

(function () {
  if (window.__UICHECKER_INSPECTOR_LOADED__) return;
  window.__UICHECKER_INSPECTOR_LOADED__ = true;

  const LOG = (...a) => console.debug('[uichecker:inspector]', ...a);
  LOG('inspector loaded on', location.href);

  // ── State ──────────────────────────────────────────────────────────────────
  let inspectorActive = false;
  let hoveredEl = null;
  let labelEl = null;

  // ── Inspector mode — hover highlight + click capture ───────────────────────
  function startInspector() {
    if (inspectorActive) return;
    inspectorActive = true;
    LOG('inspector mode ON');

    // Create floating label
    labelEl = document.createElement('div');
    labelEl.id = '__uic_inspector_label__';
    labelEl.style.cssText = `
      position:fixed;top:0;left:0;z-index:2147483647;
      font:600 11px/1 ui-monospace,monospace;
      padding:4px 8px;border-radius:0 0 5px 0;
      background:#1a1aff;color:#fff;pointer-events:none;
      display:none;white-space:nowrap;
    `;
    document.body.appendChild(labelEl);

    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout',  onMouseOut,  true);
    document.addEventListener('click',     onClick,     true);
    document.addEventListener('keydown',   onKeyDown,   true);
  }

  function stopInspector() {
    if (!inspectorActive) return;
    inspectorActive = false;
    LOG('inspector mode OFF');
    clearHighlight();
    labelEl?.remove(); labelEl = null;
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout',  onMouseOut,  true);
    document.removeEventListener('click',     onClick,     true);
    document.removeEventListener('keydown',   onKeyDown,   true);
  }

  function onMouseOver(e) {
    const el = e.target;
    if (el === hoveredEl || el.id === '__uic_inspector_label__') return;
    clearHighlight();
    hoveredEl = el;
    el.classList.add('__uic_hover__');
    // Update label
    if (labelEl) {
      const tag = el.tagName.toLowerCase();
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      const id = el.id ? `#${el.id}` : '';
      labelEl.textContent = `${tag}${id}${cls}`;
      labelEl.style.display = 'block';
    }
  }

  function onMouseOut(e) {
    if (e.target === hoveredEl) { clearHighlight(); hoveredEl = null; }
    if (labelEl) labelEl.style.display = 'none';
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      stopInspector();
      chrome.runtime.sendMessage({ action: 'inspector-cancelled' }).catch(() => {});
    }
  }

  function clearHighlight() {
    hoveredEl?.classList.remove('__uic_hover__');
  }

  function onClick(e) {
    if (!inspectorActive) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    if (!el || el.id === '__uic_inspector_label__') return;

    LOG('element selected', el.tagName);
    stopInspector();
    sendComponentPayload(el);
  }

  // ── Component payload extraction ───────────────────────────────────────────
  function sendComponentPayload(el) {
    // Clone and clean outerHTML
    const clone = el.cloneNode(true);
    // Remove scripts and uichecker artefacts
    clone.querySelectorAll('script, style, [id^="__uic"]').forEach(n => n.remove());

    // Smart CSS filter — layout, colour, typography, spacing only
    // Excludes browser defaults by comparing against a clean div
    const cs = window.getComputedStyle(el);
    const LAYOUT = [
      'display','position','top','right','bottom','left',
      'width','height','min-width','min-height','max-width','max-height',
      'flex','flex-direction','flex-wrap','align-items','justify-content',
      'align-self','flex-grow','flex-shrink','gap','grid','grid-template-columns',
      'grid-template-rows','grid-column','grid-row',
    ];
    const COLOUR = [
      'color','background-color','background-image','border-color',
      'outline-color','box-shadow','opacity',
    ];
    const TYPOGRAPHY = [
      'font-family','font-size','font-weight','font-style','line-height',
      'letter-spacing','text-align','text-transform','text-decoration',
      'white-space','word-break',
    ];
    const SPACING = [
      'padding','padding-top','padding-right','padding-bottom','padding-left',
      'margin','margin-top','margin-right','margin-bottom','margin-left',
    ];
    const SHAPE = ['border','border-radius','overflow','transform','transition','cursor','z-index'];

    const ALL_PROPS = [...LAYOUT,...COLOUR,...TYPOGRAPHY,...SPACING,...SHAPE];

    // Filter out browser defaults by checking a fresh element
    const dummy = document.createElement('div');
    document.body.appendChild(dummy);
    const dummyCs = window.getComputedStyle(dummy);
    const cssLines = ALL_PROPS
      .map(p => {
        const v = cs.getPropertyValue(p).trim();
        const d = dummyCs.getPropertyValue(p).trim();
        return v && v !== d && v !== 'none' && v !== 'normal' && v !== 'auto'
          ? `${p}: ${v}`
          : null;
      })
      .filter(Boolean);
    dummy.remove();

    const payload = {
      tag: el.tagName.toLowerCase(),
      html: clone.outerHTML.slice(0, 8000), // cap at 8KB
      css: cssLines.join(';\n'),
      url: location.href,
    };
    LOG('sending clone payload', payload.tag, cssLines.length, 'CSS props');
    chrome.runtime.sendMessage({ action: 'clone-component', payload }).catch(() => {});
  }

  // ── DOM extraction for AI audit ───────────────────────────────────────────
  function extractAuditDom() {
    const clone = document.documentElement.cloneNode(true);
    // Strip noise
    clone.querySelectorAll('script,style,svg,noscript,template,[id^="__uic"]')
         .forEach(n => n.remove());
    // Remove all attributes except semantic ones
    clone.querySelectorAll('*').forEach(el => {
      const keep = ['href','src','alt','aria-label','aria-role','role','type','name'];
      [...el.attributes].forEach(attr => {
        if (!keep.includes(attr.name)) el.removeAttribute(attr.name);
      });
    });
    // Trim to 4000 chars of text
    const text = clone.body?.innerText || clone.innerText || '';
    const html = clone.body?.innerHTML?.slice(0, 15000) || '';
    return { text: text.slice(0, 4000), html, url: location.href, title: document.title };
  }

  // ── SEO extraction (deterministic) ────────────────────────────────────────
  function extractSEO() {
    const get = sel => document.querySelector(sel);
    const getAll = sel => [...document.querySelectorAll(sel)];
    const getMeta = name =>
      get(`meta[name="${name}"]`)?.content ||
      get(`meta[property="${name}"]`)?.content || null;

    // Core tags
    const title = document.title;
    const metaDesc = getMeta('description');
    const canonical = get('link[rel="canonical"]')?.href || null;
    const robots = getMeta('robots');

    // Open Graph
    const og = {
      title: getMeta('og:title'),
      description: getMeta('og:description'),
      image: getMeta('og:image'),
      url: getMeta('og:url'),
      type: getMeta('og:type'),
    };

    // Twitter
    const twitter = {
      card: getMeta('twitter:card'),
      title: getMeta('twitter:title'),
      description: getMeta('twitter:description'),
      image: getMeta('twitter:image'),
    };

    // Headings
    const headings = {};
    for (let i = 1; i <= 6; i++) {
      headings[`h${i}`] = getAll(`h${i}`).map(h => h.textContent.trim().slice(0, 80));
    }

    // Images missing alt
    const images = getAll('img');
    const missingAlt = images.filter(img => !img.alt || img.alt.trim() === '');

    // Schema
    const schemas = getAll('script[type="application/ld+json"]').map(s => {
      try { return JSON.parse(s.textContent); } catch { return null; }
    }).filter(Boolean);

    // Links
    const links = getAll('a[href]');
    const internalLinks = links.filter(a => {
      try { return new URL(a.href).hostname === location.hostname; } catch { return false; }
    });
    const emptyAnchors = links.filter(a => !a.textContent.trim() && !a.querySelector('img[alt]'));

    // Hreflang
    const hreflang = getAll('link[hreflang]').map(l => ({
      lang: l.hreflang, href: l.href,
    }));

    // Core Web Vitals via Performance API
    const navEntry = performance.getEntriesByType('navigation')[0];
    const perf = navEntry ? {
      ttfb: Math.round(navEntry.responseStart - navEntry.requestStart),
      domContentLoaded: Math.round(navEntry.domContentLoadedEventEnd - navEntry.startTime),
      load: Math.round(navEntry.loadEventEnd - navEntry.startTime),
    } : null;

    // Largest Contentful Paint
    let lcp = null;
    const lcpEntry = performance.getEntriesByType('largest-contentful-paint');
    if (lcpEntry.length) lcp = Math.round(lcpEntry[lcpEntry.length - 1].startTime);

    // Build findings
    const critical = [], warnings = [], info = [];

    // Title checks
    if (!title) critical.push({ id: 'missing-title', label: 'Missing title tag', fix: 'Add a <title> element to your <head>' });
    else if (title.length < 30) warnings.push({ id: 'short-title', label: `Title too short (${title.length} chars)`, fix: 'Aim for 50–60 characters' });
    else if (title.length > 60) warnings.push({ id: 'long-title', label: `Title too long (${title.length} chars)`, fix: 'Trim to 60 characters max' });
    else info.push({ id: 'title-ok', label: `Title: "${title.slice(0, 50)}"` });

    // Meta description
    if (!metaDesc) critical.push({ id: 'missing-meta-desc', label: 'Missing meta description', fix: 'Add <meta name="description" content="..."> (150–160 chars)' });
    else if (metaDesc.length < 100) warnings.push({ id: 'short-meta-desc', label: `Meta description too short (${metaDesc.length} chars)`, fix: 'Aim for 150–160 characters' });
    else if (metaDesc.length > 160) warnings.push({ id: 'long-meta-desc', label: `Meta description too long (${metaDesc.length} chars)`, fix: 'Trim to 160 characters max' });
    else info.push({ id: 'meta-desc-ok', label: 'Meta description: ✓ good length' });

    // Canonical
    if (!canonical) warnings.push({ id: 'missing-canonical', label: 'No canonical tag found', fix: 'Add <link rel="canonical" href="..."> to prevent duplicate content issues' });
    else info.push({ id: 'canonical-ok', label: `Canonical: ${canonical.slice(0, 60)}` });

    // Robots
    if (robots && (robots.includes('noindex') || robots.includes('none'))) {
      critical.push({ id: 'noindex', label: `robots: "${robots}" — page is blocked from indexing`, fix: 'Remove noindex directive unless intentional' });
    }

    // OG tags
    if (!og.title) warnings.push({ id: 'missing-og-title', label: 'Missing og:title', fix: 'Add <meta property="og:title"> for social sharing' });
    if (!og.image) warnings.push({ id: 'missing-og-image', label: 'Missing og:image', fix: 'Add <meta property="og:image"> — shown in social previews' });
    if (!og.description) warnings.push({ id: 'missing-og-desc', label: 'Missing og:description', fix: 'Add <meta property="og:description">' });

    // H1
    const h1s = headings.h1;
    if (h1s.length === 0) critical.push({ id: 'missing-h1', label: 'No H1 tag found', fix: 'Every page needs exactly one H1 as the primary heading' });
    else if (h1s.length > 1) warnings.push({ id: 'multiple-h1', label: `${h1s.length} H1 tags found`, fix: 'Use only one H1 per page' });
    else info.push({ id: 'h1-ok', label: `H1: "${h1s[0]?.slice(0, 60)}"` });

    // Images
    if (missingAlt.length > 0) warnings.push({ id: 'missing-alt', label: `${missingAlt.length} image(s) missing alt text`, fix: 'Add descriptive alt attributes to all meaningful images' });

    // Schema
    if (schemas.length === 0) info.push({ id: 'no-schema', label: 'No JSON-LD schema found', fix: 'Consider adding Schema.org markup for rich results' });
    else info.push({ id: 'schema-ok', label: `${schemas.length} schema(s) detected: ${schemas.map(s => s['@type']).join(', ')}` });

    // Performance
    if (perf) {
      if (perf.ttfb > 600) warnings.push({ id: 'slow-ttfb', label: `TTFB: ${perf.ttfb}ms (slow)`, fix: 'Optimize server response time. Target <200ms' });
      if (perf.load > 3000) warnings.push({ id: 'slow-load', label: `Page load: ${perf.load}ms`, fix: 'Optimize assets, defer non-critical JS' });
    }
    if (lcp !== null && lcp > 2500) warnings.push({ id: 'poor-lcp', label: `LCP: ${lcp}ms (needs improvement)`, fix: 'Preload hero images, optimize largest visible element' });

    // Empty anchors
    if (emptyAnchors.length > 0) warnings.push({ id: 'empty-anchors', label: `${emptyAnchors.length} link(s) with no anchor text`, fix: 'Add descriptive text to all links for SEO and accessibility' });

    // Score (rough 0–100)
    const total = critical.length * 15 + warnings.length * 5;
    const score = Math.max(0, Math.min(100, 100 - total));

    LOG('SEO extraction complete', { score, critical: critical.length, warnings: warnings.length });

    return {
      score, url: location.href, title, metaDesc, canonical,
      og, twitter, headings, schemas, hreflang, perf, lcp,
      critical, warnings, info,
      imageCount: images.length, missingAltCount: missingAlt.length,
      internalLinkCount: internalLinks.length, totalLinks: links.length,
    };
  }

  // ── Message listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    LOG('message received', msg.action);

    if (msg.action === 'start-inspector') {
      startInspector();
      sendResponse({ ok: true });
    }
    if (msg.action === 'stop-inspector') {
      stopInspector();
      sendResponse({ ok: true });
    }
    if (msg.action === 'extract-seo') {
      const data = extractSEO();
      chrome.runtime.sendMessage({ action: 'seo-data', data });
      sendResponse({ ok: true });
    }
    if (msg.action === 'extract-audit-dom') {
      const dom = extractAuditDom();
      chrome.runtime.sendMessage({ action: 'dom-for-audit', dom });
      sendResponse({ ok: true });
    }
    if (msg.action === 'toggle-overlays') {
      // Forward to page context via postMessage for v1 detector
      window.postMessage({ source: 'uichecker-command', action: 'toggle-overlays' }, '*');
      sendResponse({ ok: true });
    }
    return true;
  });

  // ── Relay detector results to SW ─────────────────────────────────────────
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data) return;
    if (e.data.source === 'uichecker-results') {
      chrome.runtime.sendMessage({
        action: 'findings', findings: e.data.findings || [],
      }).catch(() => {});
    }
    if (e.data.source === 'uichecker-ready' && e.data.scanId) {
      chrome.runtime.sendMessage({
        action: 'detector-ready', scanId: e.data.scanId,
      }).catch(() => {});
    }
    if (e.data.source === 'uichecker-overlays-toggled') {
      chrome.runtime.sendMessage({
        action: 'overlays-toggled', visible: e.data.visible,
      }).catch(() => {});
    }
  });

})();
