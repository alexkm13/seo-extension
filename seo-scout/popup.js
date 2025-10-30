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
          const clone = document.documentElement.cloneNode(true);
          clone.querySelectorAll("script,style,noscript,template").forEach(n => n.remove());
          return clone.innerText || "";
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
        const words = wordCount(getTextContent());
  
        const imgs = [...document.images];
        const imgsMissingAlt = imgs.filter(i => !i.hasAttribute("alt") || i.getAttribute("alt").trim() === "");
  
        const anchors = [...document.querySelectorAll("a[href]")];
        const emptyAnchors = anchors.filter(a => (a.textContent || "").trim().length === 0);
        const weakAnchors = anchors.filter(a => {
          const t = (a.textContent || "").trim();
          return t.length > 0 && t.length <= 3;
        });
  
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
        add("anchor-text",
          emptyAnchors.length === 0 && (weakAnchors.length / Math.max(1, anchors.length)) < 0.15,
          emptyAnchors.length ? "warn" : ((weakAnchors.length / Math.max(1, anchors.length)) < 0.15 ? "pass" : "warn"),
          `Empty anchors: ${emptyAnchors.length}; weak anchors (<= 3 chars): ${weakAnchors.length}.`,
          [...emptyAnchors.map(describeEl), ...weakAnchors.map(describeEl)]);
        add("open-graph", ogCount > 0, ogCount ? "pass" : "warn",
          ogCount ? `Open Graph tags: ${ogCount}` : "No Open Graph tags.");
        add("twitter-card", twCount > 0, twCount ? "pass" : "warn",
          twCount ? `Twitter Card tags: ${twCount}` : "No Twitter Card tags.");
  
        return {
          report: {
            url, timestamp: Date.now(),
            summary: { title, metaDesc, canonical, robots, viewport, lang, words },
            checks
          }
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
  }
  
  // ---- wire up ----
  document.getElementById("scan").addEventListener("click", async () => {
    const tab = await activeTab();
    if (!tab) { render(null); return; }
    try { render(await getReportRobust(tab.id)); }
    catch (e) { console.error(e); render(null); }
  });
  
  (async () => {
    const tab = await activeTab();
    if (!tab) { render(null); return; }
    try { render(await getReportRobust(tab.id)); }
    catch (e) { console.error(e); render(null); }
  })();
  