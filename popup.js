// --- helpers ---
function activeTab() {
    return new Promise(resolve => {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs && tabs.length ? tabs[0] : null));
    });
  }
  function sevClass(s){ return s==="pass"?"pass":(s==="warn"?"warn":"fail"); }
  
  // Try messaging first (if your content.js has listeners)
  function sendMessage(tabId, payload) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, payload, (response) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(response);
      });
    });
  }
  
  // Analyzer injected directly into the page (no content script required)
  async function analyzeViaInjection(tabId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: () => {
        // ---- in-page analyzer (no async) ----
        function getTextContent() {
          const root = document.body || document.documentElement;
          return (root && root.innerText) ? root.innerText : "";
        }
        function wordCount(text) {
          const m = text.toLowerCase().match(/[a-z0-9]+/g);
          return m ? m.length : 0;
        }
        function headingHierarchyOK() {
          const list = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")];
          let last = 0;
          for (const h of list) {
            const lvl = Number(h.tagName[1]);
          if (last && lvl > last + 1) return { ok:false, offender:h, msg:`Heading jump H${last} -> H${lvl}` };
            last = lvl;
          }
          return { ok:true };
        }
        function describeEl(el) {
          try {
            const tag = el.tagName ? el.tagName.toLowerCase() : "node";
            const id = el.id ? `#${el.id}` : "";
            const cls = el.classList && el.classList.length ? 
              "." + Array.from(el.classList).slice(0, 2).join(".") : "";
            const attr = el.getAttribute ? (el.getAttribute("href") || el.getAttribute("src") || "") : "";
            const attrPart = attr ? ` ${attr.substring(0, 80)}` : "";
            return `${tag}${id}${cls}${attrPart}`;
          } catch {
            return "[unserializable element]";
          }
        }
  
        const url = location.href.split("#")[0];
        const title = (document.title || "").trim();
        const metaDesc = document.querySelector('meta[name="description"]')?.content?.trim() || "";
        const robots = document.querySelector('meta[name="robots"]')?.content?.toLowerCase() || "";
        const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
        const viewport = document.querySelector('meta[name="viewport"]')?.content || "";
        const lang = document.documentElement.getAttribute("lang") || "";
  
        const h1s = [...document.querySelectorAll("h1")];
        const hh = headingHierarchyOK();
        const visibleText = getTextContent();
        const words = wordCount(visibleText);
        const textChars = visibleText.length;
        const htmlSize = (document.documentElement.outerHTML || "").length;

        // URL structure flags
        const u = new URL(url);
        const path = u.pathname;
        const urlStructure = {
          hasUppercase: /[A-Z]/.test(u.href),
          hasUnderscore: /_/.test(u.href),
          longQuery: (u.search || "").length > 120,
          doubleSlashInPath: /\/\//.test(path.replace(/^\/+/, '')),
          trailingSlashInconsistent: (path !== '/' && ((path.endsWith('/') && !u.pathname.match(/^\/$/)) || (!path.endsWith('/') && path.split('/').pop() === ''))),
          nonAscii: /[^\x00-\x7F]/.test(u.href)
        };

        // Hreflang
        const hreflangs = Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]'))
          .map(l => ({ hreflang: (l.getAttribute('hreflang')||'').trim(), href: l.getAttribute('href')||'' }))
          .filter(x => x.hreflang);
        const hreflangInvalid = hreflangs.filter(x => !/^([a-z]{2,3})(-[A-Za-z0-9]{2,8})?$/.test(x.hreflang));

        // Structured data (ld+json + microdata/RDFa types)
        const sdTypes = [];
        Array.from(document.querySelectorAll('script[type="application/ld+json"]')).forEach(s => {
          try {
            const data = JSON.parse(s.textContent || 'null');
            const collect = (node) => {
              if (!node) return;
              if (Array.isArray(node)) { node.forEach(collect); return; }
              if (typeof node === 'object') {
                if (node['@type']) sdTypes.push(String(node['@type']));
                Object.values(node).forEach(collect);
              }
            };
            collect(data);
          } catch {}
        });
        const microdataTypes = Array.from(document.querySelectorAll('[itemscope][itemtype]'))
          .map(el => el.getAttribute('itemtype') || '')
          .filter(Boolean);
        const structuredDataTypes = Array.from(new Set([...sdTypes, ...microdataTypes])).slice(0, 50);

        // Performance snapshot (avoid deprecated performance.timing)
        const navEntries = performance.getEntriesByType ? performance.getEntriesByType('navigation') : [];
        const nav = (navEntries && navEntries[0]) || {};
        const perf = {
          transferSize: nav.transferSize || 0,
          decodedBodySize: nav.decodedBodySize || 0,
          redirectCount: nav.redirectCount || 0,
          ttfbMs: (nav.responseStart && nav.requestStart) ? Math.max(0, Math.round(nav.responseStart - nav.requestStart)) : 0
        };

        // Content depth: simple top n-grams (cap input)
        const textForNgrams = (visibleText || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20000);
        const tokens = textForNgrams ? textForNgrams.split(' ') : [];
        function topNGrams(n, limit) {
          const counts = new Map();
          for (let i=0;i+ n<=tokens.length;i++) {
            const key = tokens.slice(i, i+n).join(' ');
            if (!key) continue;
            counts.set(key, (counts.get(key)||0)+1);
          }
          return Array.from(counts.entries()).sort((a,b)=>b[1]-a[1]).slice(0, limit).map(([g,c])=>({gram:g,count:c}));
        }
        const top1 = topNGrams(1, 10);
        const top2 = topNGrams(2, 10);
        const top3 = topNGrams(3, 10);
  
        const imgs = [...document.images];
        const imgsMissingAlt = imgs.filter(i => !i.hasAttribute("alt") || i.getAttribute("alt").trim() === "");
        const imgsBroken = imgs.filter(i => (i.complete && i.naturalWidth === 0));
  
        const anchors = [...document.querySelectorAll("a[href]")];
        const emptyAnchors = anchors.filter(a => (a.textContent || "").trim().length === 0);
        const weakAnchors = anchors.filter(a => {
          const t = (a.textContent || "").trim();
          return t.length > 0 && t.length <= 3;
        });
        const linkHrefs = Array.from(new Set(
          anchors.slice(0, 200)
            .map(a => a.href)
            .filter(h => /^https?:\/\//i.test(h))
        )).slice(0, 200);
  
        const ogCount = document.querySelectorAll('meta[property^="og:"]').length;
        const twCount = document.querySelectorAll('meta[name^="twitter:"]').length;
  
        const checks = [];
        const add = (id, ok, severity, message, where=[]) => checks.push({ id, ok, severity, message, where });
  
        add("title-length", title.length >= 50 && title.length <= 60,
          title ? (title.length >= 50 && title.length <= 60 ? "pass" : "warn") : "fail",
          `Title length: ${title.length || 0} (recommended 50-60).`);
        add("meta-description", metaDesc.length >= 120 && metaDesc.length <= 160,
          metaDesc ? (metaDesc.length >= 120 && metaDesc.length <= 160 ? "pass" : "warn") : "fail",
          `Meta description length: ${metaDesc.length || 0} (recommended 120-160).`);
        add("h1-count", h1s.length === 1,
          h1s.length === 0 ? "fail" : (h1s.length === 1 ? "pass" : "warn"),
          `H1 count: ${h1s.length}.`, h1s.map(describeEl));
        add("heading-hierarchy", hh.ok, hh.ok ? "pass" : "warn",
          hh.ok ? "Heading levels are sequential." : hh.msg, hh.ok ? [] : (hh.offender ? [describeEl(hh.offender)] : []));
        add("canonical", !!canonical, canonical ? "pass" : "warn",
          canonical ? `Canonical present: ${canonical}` : "No canonical tag found.");
        const noindex = robots.includes("noindex");
        add("robots-meta", !noindex, noindex ? "fail" : "pass",
          noindex ? "Meta robots contains noindex (page won't be indexed)." : "No noindex in meta robots.");
        add("viewport", !!viewport, viewport ? "pass" : "warn",
          viewport ? "Viewport meta present." : "No viewport meta (mobile).");
        add("lang", !!lang, lang ? "pass" : "warn",
          lang ? 'html[lang="' + lang + '"] present.' : "Missing html[lang] attribute.");
        add("image-alt", imgsMissingAlt.length === 0, imgsMissingAlt.length === 0 ? "pass" : "warn",
          `Images missing alt: ${imgsMissingAlt.length}/${imgs.length}.`, imgsMissingAlt.map(describeEl));
        add("image-broken", imgsBroken.length === 0, imgsBroken.length === 0 ? "pass" : "warn",
          `Broken images (naturalWidth=0): ${imgsBroken.length}.`, imgsBroken.map(describeEl));
        add("anchor-text",
          emptyAnchors.length === 0 && (weakAnchors.length / Math.max(1, anchors.length)) < 0.15,
          emptyAnchors.length ? "warn" : ((weakAnchors.length / Math.max(1, anchors.length)) < 0.15 ? "pass" : "warn"),
          `Empty anchors: ${emptyAnchors.length}; weak anchors (<= 3 chars): ${weakAnchors.length}.`,
          [...emptyAnchors.map(describeEl), ...weakAnchors.map(describeEl)]);
        add("open-graph", ogCount > 0, ogCount ? "pass" : "warn",
          ogCount ? `Open Graph tags: ${ogCount}` : "No Open Graph tags.");
        add("twitter-card", twCount > 0, twCount ? "pass" : "warn",
          twCount ? `Twitter Card tags: ${twCount}` : "No Twitter Card tags.");

        // URL structure quick badge
        const urlIssues = Object.entries(urlStructure).filter(([,v])=>!!v).map(([k])=>k);
        add("url-structure", urlIssues.length === 0, urlIssues.length ? "warn" : "pass",
          urlIssues.length ? `URL issues: ${urlIssues.join(', ')}` : "URL looks tidy.");

        // Content depth metrics
        add("content-length", words >= 200, words >= 200 ? "pass" : "warn",
          `Text length: ${words} words, ${textChars} chars. Text/code ratio: ${htmlSize?Math.round(100*textChars/htmlSize):0}%`);
        add("keyword-density", true, "pass",
          `Top n-grams: 1:${top1.slice(0,3).map(x=>x.gram).join('/')}, 2:${top2.slice(0,2).map(x=>x.gram).join('/')}, 3:${top3.slice(0,2).map(x=>x.gram).join('/')}`);

        // Hreflang baseline
        add("hreflang", hreflangs.length > 0 && hreflangInvalid.length === 0,
          hreflangs.length ? (hreflangInvalid.length ? "warn" : "pass") : "warn",
          hreflangs.length ? (hreflangInvalid.length ? `Invalid hreflang(s): ${hreflangInvalid.map(x=>x.hreflang).join(', ')}` : `Hreflang count: ${hreflangs.length}`) : "No hreflang alternates.");

        // Structured data types
        add("structured-data", structuredDataTypes.length>0, structuredDataTypes.length?"pass":"warn",
          structuredDataTypes.length?`Types: ${structuredDataTypes.slice(0,5).join(', ')}`:"No structured data detected.");
  
        return {
          report: {
            url, timestamp: Date.now(),
            summary: { title, metaDesc, canonical, robots, viewport, lang, words, textChars, htmlSize, urlStructure, hreflangs, structuredDataTypes, perf },
            checks
          },
          linksSample: linkHrefs
        };
      }
    });
  
    // `results` is an array of {frameId, result}
    const first = results && results[0] && results[0].result;
    if (!first) throw new Error("No result from injected analyzer.");
    return first;
  }
  
  // Try message path; if that fails, fall back to injection
  async function getReportRobust(tabId) {
    try {
      return await sendMessage(tabId, { type: "GET_SEO_REPORT" });
    } catch {
      return await analyzeViaInjection(tabId);
    }
  }

  async function augmentReportNetwork(report) {
    try {
      const u = report?.report?.url || report?.url;
      if (!u) return report;
      // Overall time budget for augmentation
      const startMs = Date.now();
      const timeBudgetMs = 3000;
      const timeLeft = () => Math.max(0, timeBudgetMs - (Date.now() - startMs));
      const ctrlMain = new AbortController();
      const headTimeout = setTimeout(() => ctrlMain.abort(), Math.min(2000, timeLeft()));
      const headResp = await fetch(u, { method: 'HEAD', redirect: 'manual', signal: ctrlMain.signal });
      clearTimeout(headTimeout);
      const status = headResp.status;
      const xRobots = headResp.headers.get('x-robots-tag') || '';
      const cacheControl = headResp.headers.get('cache-control') || '';
      const robotsUrl = new URL('/robots.txt', u).toString();
      let robotsTxt = '';
      try {
        if (timeLeft() <= 0) throw new Error('time budget');
        const ctrlRobots = new AbortController();
        const robotsTimeout = setTimeout(() => ctrlRobots.abort(), Math.min(1500, timeLeft()));
        const robotsResp = await fetch(robotsUrl, { method: 'GET', signal: ctrlRobots.signal });
        clearTimeout(robotsTimeout);
        if (robotsResp.ok) robotsTxt = await robotsResp.text();
      } catch {}
      let blockedByRobots = false;
      try {
        const path = new URL(u).pathname;
        const disallows = robotsTxt.split(/\r?\n/).filter(l=>/^disallow:/i.test(l)).map(l=>l.split(':')[1].trim());
        blockedByRobots = disallows.some(rule => rule && path.startsWith(rule));
      } catch {}

      const checks = report.report?.checks || report.checks || [];
      // Links audit: classify and sample broken via HEAD (cap 50)
      const allLinks = (report.linksSample || []).filter(h => /^https?:\/\//i.test(h)).slice(0, 120);
      const origin = new URL(u).origin;
      let internal = 0, external = 0, subdomain = 0, relNoFollow=0, relUGC=0, relSponsored=0;
      try {
        // we do not have rel flags here (came from in-page); skip flags collection for now
      } catch {}
      allLinks.forEach(h => {
        try {
          const lu = new URL(h, u);
          if (lu.origin === origin) internal++; else if (lu.hostname.endsWith('.'+new URL(u).hostname)) subdomain++; else external++;
        } catch {}
      });

      const sampleForHead = allLinks.slice(0, 20);
      const broken = [];
      const concurrency = 6;
      async function headWithTimeout(url, ms) {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), ms);
        try {
          return await fetch(url, { method: 'HEAD', redirect: 'manual', signal: ctrl.signal });
        } finally {
          clearTimeout(to);
        }
      }
      for (let i = 0; i < sampleForHead.length; i += concurrency) {
        const batch = sampleForHead.slice(i, i + concurrency);
        await Promise.all(batch.map(async (h) => {
          try {
            if (timeLeft() <= 0) return;
            const r = await headWithTimeout(h, Math.min(1500, timeLeft()));
            if (!r || r.status >= 400) broken.push({ url: h, status: r ? r.status : 0 });
          } catch {
            broken.push({ url: h, status: 0 });
          }
        }));
      }

      const add = (id, ok, severity, message) => checks.push({ id, ok, severity, message, where: [] });
      add('links-audit', broken.length === 0, broken.length? 'warn':'pass', `Links: internal ${internal}, external ${external}, subdomain ${subdomain}. Broken (sample ${sampleForHead.length}): ${broken.length}`);
      add('http-status', status>=200 && status<400, (status>=200 && status<400)?'pass':'warn', `HTTP status: ${status}`);
      if (xRobots) {
        const xrNoindex = /(^|,|\s)noindex(,|\s|$)/i.test(xRobots);
        add('x-robots-tag', !xrNoindex, xrNoindex?'fail':'pass', `X-Robots-Tag: ${xRobots}`);
      } else {
        add('x-robots-tag', true, 'pass', 'No X-Robots-Tag header.');
      }
      add('cache-headers', !!cacheControl, cacheControl? 'pass':'warn', cacheControl? `cache-control: ${cacheControl}` : 'No cache-control header.');
      add('robots.txt', !blockedByRobots, blockedByRobots?'fail':'pass', blockedByRobots? 'Blocked by robots.txt' : 'Not blocked by robots.txt');

      if (report.report) report.report.checks = checks; else report.checks = checks;
    } catch {}
    return report;
  }
  
  // ---- UI render ----
  function render(res) {
    const urlEl = document.getElementById("url");
    const wordsEl = document.getElementById("words");
    const checksEl = document.getElementById("checks");
  
    if (!res || !res.report) {
      urlEl.textContent = "This page can't be analyzed.";
      wordsEl.textContent = "";
      checksEl.innerHTML = "";
      return;
    }
    const report = res.report;
    urlEl.textContent = report.summary?.title ? `${report.url} - "${report.summary.title}"` : report.url;
    wordsEl.textContent = `Approx. word count: ${report.summary?.words ?? "-"}`;
  
    checksEl.textContent = "";
    for (const c of report.checks) {
      const div = document.createElement("div");
      div.className = `check ${sevClass(c.severity)}`;

      const strong = document.createElement("strong");
      strong.textContent = c.id;
      div.appendChild(strong);

      const msg = document.createElement("div");
      msg.className = "small";
      msg.textContent = c.message;
      div.appendChild(msg);

      if (c.where && c.where.length) {
        const count = document.createElement("div");
        count.className = "small";
        count.textContent = `Elements flagged: ${c.where.length}`;
        div.appendChild(count);
      }

      checksEl.appendChild(div);
    }

    // Save current report and show diff vs previous
    try {
      const key = `report:${report.url}`;
      chrome.storage.local.get([key], (data) => {
        const prev = data[key];
        const now = { checks: report.checks.length, title: report.summary?.title };
        if (prev) {
          const diffDiv = document.createElement("div");
          diffDiv.className = "check pass";
          const delta = now.checks - (prev.checks || 0);
          diffDiv.textContent = `Changes since last run: checks ${prev.checks||0} -> ${now.checks} (${delta>=0?'+':''}${delta})`;
          checksEl.prepend(diffDiv);
        }
        chrome.storage.local.set({ [key]: now });
      });
    } catch {}
  }
  
  // ---- wire up ----
  document.getElementById("scan").addEventListener("click", async () => {
    const tab = await activeTab();
    if (!tab) { render(null); return; }
    try {
      const base = await getReportRobust(tab.id);
      render(base);
      const deep = document.getElementById('deep');
      if (deep && deep.checked) {
        const augmented = await augmentReportNetwork(base);
        render(augmented);
      }
    } catch (e) { console.error(e); render(null); }
  });
  
  (async () => {
    const tab = await activeTab();
    if (!tab) { render(null); return; }
    try {
      const base = await getReportRobust(tab.id);
      render(base);
      const deep = document.getElementById('deep');
      if (deep && deep.checked) {
        const augmented = await augmentReportNetwork(base);
        render(augmented);
      }
    } catch (e) { console.error(e); render(null); }
  })();
  