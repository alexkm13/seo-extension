function activeTab() {
    return new Promise(resolve => {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs && tabs.length ? tabs[0] : null));
    });
  }
  function isHttpUrl(u){ try { const p=new URL(u); return p.protocol==='http:'||p.protocol==='https:'; } catch { return false; } }
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

  function injectContent(tabId) {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        { target: { tabId, allFrames: true }, files: ["content.js"] },
        () => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          resolve();
        }
      );
    });
  }

  async function getReportRobust(tabId) {
    try { await sendMessage(tabId, { type: "PING" }); }
    catch { await injectContent(tabId); await sendMessage(tabId, { type: "PING" }); }
  
    try {
      const report = await sendMessage(tabId, { type: "GET_SEO_REPORT_AI" });
      if (report?.report) return report;
    } catch {}
    const base = await sendMessage(tabId, { type: "GET_SEO_REPORT" });
    if (base?.error) throw new Error(base.error);
    return base;
  }
  
  async function analyzeViaInjection(tabId) {
    // Get current tab URL to detect navigation
    const tab = await chrome.tabs.get(tabId);
    const initialUrl = tab.url?.split('#')[0] || '';
    
    // Quick check before injection - ensure tab is not loading
    if (tab.status === 'loading') {
      throw new Error('Page is currently loading - please wait for page to finish loading before scanning');
    }
    
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: async (initialUrlParam) => {
        // Quick check: If page is actively loading, abort
        if (document.readyState === 'loading') {
          throw new Error('Page is currently loading');
        }
        
        // Quick check for dynamically loaded content - don't wait if already present
        const hasTitle = document.querySelector('title')?.textContent?.trim() || document.title?.trim();
        const hasMetaDesc = document.querySelector('meta[name="description"]') || 
                           document.querySelector('meta[property="description"]') ||
                           document.querySelector('meta[property="og:description"]');
        const hasH1 = document.querySelector('h1');
        
        // Only wait if elements are actually missing (reduced timeout for speed)
        if (!hasTitle || (!hasMetaDesc && !hasH1)) {
          const waitStart = Date.now();
          while (Date.now() - waitStart < 200) {
            const hasTitleNow = document.querySelector('title')?.textContent?.trim() || document.title?.trim();
            const hasMetaDescNow = document.querySelector('meta[name="description"]') || 
                                 document.querySelector('meta[property="description"]') ||
                                 document.querySelector('meta[property="og:description"]');
            const hasH1Now = document.querySelector('h1');
            
            if (hasTitleNow && (hasMetaDescNow || hasH1Now)) break;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        }
        
        // Check if URL changed (refresh happened)
        let currentUrl;
        try {
          currentUrl = (window.top !== window ? window.top.location.href : location.href).split("#")[0].split('?')[0];
        } catch (e) {
          currentUrl = location.href.split("#")[0].split('?')[0];
        }
        const initialBase = initialUrlParam.split('#')[0].split('?')[0];
        if (currentUrl !== initialBase) {
          throw new Error('Page navigated during analysis');
        }
        
        function getTextContent() {
          // Create a clone to avoid modifying the original DOM
          const clone = (document.body || document.documentElement).cloneNode(true);
          
          // Remove script/style/template/noscript
          clone.querySelectorAll("script,style,noscript,template").forEach(n => n.remove());
          
          // Remove common dynamic content that changes between scans
          // This helps stabilize results on dynamic sites
          clone.querySelectorAll("[data-dynamic], [data-live], [data-update], .live-update, .dynamic-content, [aria-live], .counter, .timer").forEach(n => n.remove());
          
          // Remove hidden elements that might be dynamically shown/hidden
          const hiddenElements = clone.querySelectorAll("[style*='display: none'], [style*='display:none'], .hidden, [aria-hidden='true']");
          hiddenElements.forEach(n => n.remove());
          
          return (clone.innerText || "").trim();
        }
        function wordCount(text) {
          const m = text.toLowerCase().match(/[a-z0-9]+/g);
          return m ? m.length : 0;
        }
        function headingHierarchyOK() {
          // Sort headings by a stable identifier for deterministic results
          // This prevents fluctuations when headings are in different document order
          const list = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].sort((a, b) => {
            const aKey = `${a.tagName}|${a.textContent || ''}|${a.id || ''}|${a.className || ''}`;
            const bKey = `${b.tagName}|${b.textContent || ''}|${b.id || ''}|${b.className || ''}`;
            return aKey.localeCompare(bKey);
          });
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
  
        // Use top window URL to avoid iframe/redirect issues
        let url;
        try {
          url = (window.top !== window ? window.top.location.href : location.href).split("#")[0];
        } catch (e) {
          // Cross-origin iframe, fall back to current location
          url = location.href.split("#")[0];
        }
        // Read title from <title> element consistently - check multiple sources
        // Filter out titles from iframes/ad containers (SafeFrame Container, Advertisement, etc.)
        const isAdOrIframeTitle = (title) => {
          if (!title || title.length < 3) return true;
          const lowerTitle = title.toLowerCase();
          const adPatterns = [
            'safeframe',
            'advertisement',
            'ad container',
            'ad frame',
            'ad iframe',
            'doubleclick',
            'google ads',
            'adsbygoogle',
            'advertisement container',
            'ad container',
            'iframe',
            'frame container',
            'widget container'
          ];
          return adPatterns.some(pattern => lowerTitle.includes(pattern));
        };
        
        let titleValue = '';
        // Try to get from top-level window if in iframe context
        try {
          if (window.top !== window && window.top.document) {
            const topTitleElement = window.top.document.querySelector('title');
            if (topTitleElement) {
              const topTitle = (topTitleElement.textContent || topTitleElement.innerText || '').trim();
              if (topTitle && !isAdOrIframeTitle(topTitle)) {
                titleValue = topTitle;
              }
            }
            if (!titleValue) {
              const topDocTitle = (window.top.document.title || '').trim();
              if (topDocTitle && !isAdOrIframeTitle(topDocTitle)) {
                titleValue = topDocTitle;
              }
            }
          }
        } catch (e) {
          // Cross-origin iframe, continue with current document
        }
        
        // If we're in top-level or cross-origin iframe, use current document
        if (!titleValue) {
          const titleElement = document.querySelector('title');
          if (titleElement) {
            const extractedTitle = (titleElement.textContent || '').trim();
            if (extractedTitle && !isAdOrIframeTitle(extractedTitle)) {
              titleValue = extractedTitle;
            }
            // Fallback to innerText if textContent is empty
            if (!titleValue) {
              const innerTitle = (titleElement.innerText || '').trim();
              if (innerTitle && !isAdOrIframeTitle(innerTitle)) {
                titleValue = innerTitle;
              }
            }
          }
          
          // Also check document.title as fallback
          if (!titleValue) {
            const docTitle = (document.title || '').trim();
            if (docTitle && !isAdOrIframeTitle(docTitle)) {
              titleValue = docTitle;
            }
          }
        }
        const title = titleValue;
        
        // Check multiple ways to get meta description (expanded for dynamic content)
        let metaDesc = '';
        // Try standard name="description" first
        let metaDescEl = document.querySelector('meta[name="description"]');
        if (metaDescEl) {
          metaDesc = metaDescEl.getAttribute('content')?.trim() || '';
        }
        // Also check property="description" (some sites use this)
        if (!metaDesc) {
          metaDescEl = document.querySelector('meta[property="description"]');
          if (metaDescEl) {
            metaDesc = metaDescEl.getAttribute('content')?.trim() || '';
          }
        }
        // Check Open Graph description as fallback (some sites only use OG)
        if (!metaDesc) {
          metaDescEl = document.querySelector('meta[property="og:description"]');
          if (metaDescEl) {
            metaDesc = metaDescEl.getAttribute('content')?.trim() || '';
          }
        }
        // Also check in head element directly if not found
        if (!metaDesc && document.head) {
          const headMetaDesc = document.head.querySelector('meta[name="description"]');
          if (headMetaDesc) {
            metaDesc = headMetaDesc.getAttribute('content')?.trim() || '';
          }
          // Also try all meta tags in head and check for description-like content
          if (!metaDesc) {
            const allMetas = document.head.querySelectorAll('meta');
            for (const meta of allMetas) {
              if (meta.getAttribute('name') === 'description' || meta.getAttribute('property') === 'description') {
                metaDesc = meta.getAttribute('content')?.trim() || '';
                if (metaDesc) break;
              }
            }
          }
        }
        const robots = document.querySelector('meta[name="robots"]')?.content?.toLowerCase() || "";
        const noindex = robots.includes("noindex");
        const nofollow = robots.includes("nofollow");
        const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
        const viewport = document.querySelector('meta[name="viewport"]')?.content || "";
        const lang = document.documentElement.getAttribute("lang") || "";
  
        // Collect H1s - be less aggressive with filtering, prioritize main content
        // Try multiple queries to catch dynamically loaded H1s
        // Quick H1 collection - no retry delay for faster analysis
        const h1Elements = [...document.querySelectorAll("h1")];
        const h1s = h1Elements
          .filter(h => {
            // Check if H1 is in main content area (main, article, section with main role)
            const isMainContent = h.closest('main, article, [role="main"], section[role="main"]') !== null;
            
            // If it's in main content, always include it (don't filter it out)
            if (isMainContent) return true;
            
            // For other H1s, only exclude if clearly in ads/widgets/modals
            let parent = h.parentElement;
            let depth = 0;
            while (parent && parent !== document.body && depth < 10) {
              const parentClass = parent.className || '';
              const parentId = parent.id || '';
              // More specific patterns - only exclude obvious ads/widgets/modals
              const isDynamic = /(ad[_-]?container|advertisement[_-]?container|widget[_-]?container|modal[_-]?container|popup[_-]?container|tooltip[_-]?container|dropdown[_-]?menu|sidebar[_-]?ad)/i.test(parentClass + parentId) ||
                               (parent.hasAttribute('data-dynamic') && parentClass.includes('ad')) ||
                               (parent.hasAttribute('aria-live') && parentClass.includes('live-update')) ||
                               parent.classList.contains('ad') ||
                               parent.classList.contains('advertisement') ||
                               parent.classList.contains('widget-ad');
              
              // Only exclude if it's clearly an ad/widget AND not in main content
              if (isDynamic && !isMainContent) return false;
              parent = parent.parentElement;
              depth++;
            }
            return true;
          })
          .sort((a, b) => {
            const aKey = `${a.textContent || ''}|${a.id || ''}|${a.className || ''}`;
            const bKey = `${b.textContent || ''}|${b.id || ''}|${b.className || ''}`;
            return aKey.localeCompare(bKey);
          });
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
  
        // Collect and sort images, filtering out dynamically added ones
        // This prevents fluctuations when images load dynamically
        const imgs = [...document.images]
          .filter(img => {
            // Exclude images in common dynamic containers (ads, widgets, live updates)
            let parent = img.parentElement;
            while (parent && parent !== document.body) {
              const parentClass = parent.className || '';
              const parentId = parent.id || '';
              const isDynamic = /(ad|advertisement|widget|live-update|dynamic|counter|timer|feed|stream|lazy|loading)/i.test(parentClass + parentId) ||
                               parent.hasAttribute('data-dynamic') ||
                               parent.hasAttribute('data-live') ||
                               parent.hasAttribute('aria-live');
              if (isDynamic) return false;
              parent = parent.parentElement;
            }
            // Also exclude very small images (likely icons/sprites) or data URIs (often dynamic)
            if (img.naturalWidth < 20 && img.naturalHeight < 20) return false;
            if (img.src && img.src.startsWith('data:')) return false;
            return true;
          })
          .sort((a, b) => {
            const aKey = `${a.src || ''}|${a.getAttribute('alt') || ''}|${a.id || ''}`;
            const bKey = `${b.src || ''}|${b.getAttribute('alt') || ''}|${b.id || ''}`;
            return aKey.localeCompare(bKey);
          });
        const imgsMissingAlt = imgs.filter(i => !i.hasAttribute("alt") || i.getAttribute("alt").trim() === "");
        const imgsBroken = imgs.filter(i => (i.complete && i.naturalWidth === 0));
  
        // Collect and sort anchors by stable identifier for deterministic results
        const anchors = [...document.querySelectorAll("a[href]")].sort((a, b) => {
          const aKey = `${a.href || ''}|${(a.textContent || '').trim()}`;
          const bKey = `${b.href || ''}|${(b.textContent || '').trim()}`;
          return aKey.localeCompare(bKey);
        });
        // Analyze anchors using best practices rubric (same as content.js)
        const anchorAnalysisUrl = url || location.href;
        let currentOrigin = '';
        try {
          currentOrigin = new URL(anchorAnalysisUrl).origin;
        } catch (e) {}
        
        let currentDomain = '';
        try {
          currentDomain = new URL(anchorAnalysisUrl).hostname.replace(/^www\./, '');
          currentDomain = currentDomain.split('.')[0];
        } catch (e) {}
        
        // Helper to get anchor text
        function getAnchorText(anchor) {
          const text = (anchor.textContent || "").trim();
          if (text.length > 0) return text;
          const img = anchor.querySelector('img');
          if (img) {
            const alt = (img.getAttribute('alt') || "").trim();
            if (alt.length > 0) return alt;
          }
          return "";
        }
        
        // Analyze anchors for best practices
        const anchorAnalysis = {
          total: anchors.length,
          analyzed: 0,
          empty: 0,
          branded: 0,
          generic: 0,
          partialMatch: 0,
          exactMatch: 0,
          descriptive: 0,
          internal: 0,
          external: 0,
          issues: []
        };
        
        const sampleSize = Math.min(anchors.length, 200);
        
        for (let i = 0; i < sampleSize; i++) {
          const anchor = anchors[i];
          const text = getAnchorText(anchor);
          const href = anchor.getAttribute('href') || anchor.href || '';
          
          anchorAnalysis.analyzed++;
          
          if (text.length === 0) {
            anchorAnalysis.empty++;
            continue;
          }
          
          const lowerText = text.toLowerCase().trim();
          const textWords = lowerText.split(/\s+/).filter(w => w.length > 0);
          
          // Detect branded anchors
          let isBranded = false;
          if (currentDomain) {
            const domainLower = currentDomain.toLowerCase();
            if (lowerText.includes(domainLower) || lowerText.includes(domainLower.replace(/\s+/g, ''))) {
              isBranded = true;
              anchorAnalysis.branded++;
            }
          }
          
          // Detect generic anchors
          const genericPatterns = /\b(click here|read more|learn more|see more|view more|here|this|link|page|website|site|url)\b/i;
          const isGeneric = genericPatterns.test(text);
          if (isGeneric && !isBranded) {
            anchorAnalysis.generic++;
            continue;
          }
          
          // Detect exact-match anchors
          const isLikelyExactMatch = textWords.length <= 5 && 
                                     text.length > 10 && 
                                     !isBranded && 
                                     !isGeneric &&
                                     !lowerText.includes('click') &&
                                     !lowerText.includes('read') &&
                                     !lowerText.includes('learn') &&
                                     !lowerText.includes('here');
          
          if (isLikelyExactMatch) {
            anchorAnalysis.exactMatch++;
          } else if (!isBranded && !isGeneric && text.length > 5) {
            anchorAnalysis.partialMatch++;
          }
          
          // Check if descriptive
          const isDescriptive = text.length >= 10 && 
                               textWords.length >= 2 && 
                               !isGeneric;
          if (isDescriptive) {
            anchorAnalysis.descriptive++;
          }
          
          // Classify as internal or external
          if (href) {
            try {
              const hrefUrl = new URL(href, anchorAnalysisUrl);
              if (hrefUrl.origin === currentOrigin) {
                anchorAnalysis.internal++;
              } else {
                anchorAnalysis.external++;
              }
            } catch (e) {
              if (href.startsWith('#') || href.startsWith('/') || !href.startsWith('http')) {
                anchorAnalysis.internal++;
              } else {
                anchorAnalysis.external++;
              }
            }
          }
        }
        
        // Calculate metrics
        const exactMatchRatio = anchorAnalysis.analyzed > 0 ? anchorAnalysis.exactMatch / anchorAnalysis.analyzed : 0;
        const descriptiveRatio = anchorAnalysis.analyzed > 0 ? anchorAnalysis.descriptive / anchorAnalysis.analyzed : 0;
        const totalLinks = anchorAnalysis.internal + anchorAnalysis.external;
        const internalRatio = totalLinks > 0 ? anchorAnalysis.internal / totalLinks : 0;
        const hasBalance = totalLinks === 0 || (internalRatio > 0.2 && internalRatio < 0.95);
        const varietyScore = anchorAnalysis.analyzed > 0 ? 
          (anchorAnalysis.branded + anchorAnalysis.generic + anchorAnalysis.partialMatch) / anchorAnalysis.analyzed : 0;
        
        // Determine issues
        if (anchorAnalysis.empty > 0) {
          anchorAnalysis.issues.push(`${anchorAnalysis.empty} empty anchor(s)`);
        }
        if (exactMatchRatio > 0.05) {
          anchorAnalysis.issues.push(`${(exactMatchRatio * 100).toFixed(1)}% exact-match (target: ≤5%)`);
        }
        if (descriptiveRatio < 0.5) {
          anchorAnalysis.issues.push(`Only ${(descriptiveRatio * 100).toFixed(1)}% descriptive (target: ≥50%)`);
        }
        if (!hasBalance && totalLinks > 0) {
          if (internalRatio > 0.95) {
            anchorAnalysis.issues.push('Too few external links');
          } else if (internalRatio < 0.2) {
            anchorAnalysis.issues.push('Too few internal links');
          }
        }
        if (varietyScore < 0.3) {
          anchorAnalysis.issues.push('Low anchor text variety');
        }
        
        const hasIssues = anchorAnalysis.issues.length > 0;
        const anchorStatus = hasIssues ? 'warn' : 'pass';
        const anchorMessage = hasIssues 
          ? `Anchor text issues: ${anchorAnalysis.issues.join('; ')}. Analysis: ${anchorAnalysis.branded} branded, ${anchorAnalysis.generic} generic, ${anchorAnalysis.partialMatch} partial match, ${anchorAnalysis.exactMatch} exact-match (${(exactMatchRatio * 100).toFixed(1)}%). Internal: ${anchorAnalysis.internal}, External: ${anchorAnalysis.external}.`
          : `Anchor text follows best practices. ${anchorAnalysis.branded} branded, ${anchorAnalysis.generic} generic, ${anchorAnalysis.partialMatch} partial match, ${anchorAnalysis.exactMatch} exact-match (${(exactMatchRatio * 100).toFixed(1)}%). Internal: ${anchorAnalysis.internal}, External: ${anchorAnalysis.external}.`;
        
        // Store anchor analysis data in result for post-processing scoring
        anchorAnalysis.exactMatchRatio = exactMatchRatio;
        anchorAnalysis.descriptiveRatio = descriptiveRatio;
        anchorAnalysis.internalRatio = internalRatio;
        
        const emptyAnchors = anchors.filter(a => {
          const text = getAnchorText(a);
          return text.length === 0;
        });
        
        const linkHrefs = Array.from(new Set(
          anchors.slice(0, 200)
            .map(a => (a.getAttribute('href') || a.href || ''))
            .filter(h => /^https?:\/\//i.test(h))
        )).slice(0, 200);
  
        // Collect meta tags in sorted order for deterministic results
        const ogTags = [...document.querySelectorAll('meta[property^="og:"]')].sort((a, b) => {
          const aKey = `${a.getAttribute('property') || ''}|${a.getAttribute('content') || ''}`;
          const bKey = `${b.getAttribute('property') || ''}|${b.getAttribute('content') || ''}`;
          return aKey.localeCompare(bKey);
        });
        const ogCount = ogTags.length;
        
        const twTags = [...document.querySelectorAll('meta[name^="twitter:"]')].sort((a, b) => {
          const aKey = `${a.getAttribute('name') || ''}|${a.getAttribute('content') || ''}`;
          const bKey = `${b.getAttribute('name') || ''}|${b.getAttribute('content') || ''}`;
          return aKey.localeCompare(bKey);
        });
        const twCount = twTags.length;
  
        const checks = [];
        const add = (id, ok, severity, message, where=[]) => checks.push({ id, ok, severity, message, where });
  
        add("title-length", title.length >= 45 && title.length <= 70,
          title ? (title.length >= 45 && title.length <= 70 ? "pass" : "warn") : "fail",
          `Title length: ${title.length || 0}${title ? ` | Title: "${title}"` : ''}`);
        add("meta-description", metaDesc.length >= 120 && metaDesc.length <= 160,
          metaDesc ? (metaDesc.length >= 120 && metaDesc.length <= 160 ? "pass" : "warn") : "fail",
          `Meta description length: ${metaDesc.length || 0}${metaDesc ? ` | Description: "${metaDesc}"` : ''}.`);
        add("h1-count", h1s.length === 1,
          h1s.length === 0 ? "fail" : (h1s.length === 1 ? "pass" : "warn"),
          `H1 count: ${h1s.length}.`, h1s.map(describeEl));
        add("heading-hierarchy", hh.ok, hh.ok ? "pass" : "warn",
          hh.ok ? "Heading levels are sequential." : hh.msg, hh.ok ? [] : (hh.offender ? [describeEl(hh.offender)] : []));
        add("canonical", !!canonical, canonical ? "pass" : "warn",
          canonical ? `Canonical present: ${canonical}` : "No canonical tag found.");
        // Separate checks for noindex and nofollow - each fails if present
        add("noindex", !noindex, noindex ? "fail" : "pass",
          noindex ? "Meta robots contains noindex (page won't be indexed)." : "No noindex in meta robots.");
        add("nofollow", !nofollow, nofollow ? "fail" : "pass",
          nofollow ? "Meta robots contains nofollow (links won't be followed)." : "No nofollow in meta robots.");
        add("viewport", !!viewport, viewport ? "pass" : "warn",
          viewport ? "Viewport meta present." : "No viewport meta (mobile).");
        add("lang", !!lang, lang ? "pass" : "warn",
          lang ? 'html[lang="' + lang + '"] present.' : "Missing html[lang] attribute.");
        add("image-alt", imgsMissingAlt.length === 0, imgsMissingAlt.length === 0 ? "pass" : "warn",
          `Images missing alt: ${imgsMissingAlt.length}/${imgs.length}.`, imgsMissingAlt.map(describeEl));
        add("image-broken", imgsBroken.length === 0, imgsBroken.length === 0 ? "pass" : "warn",
          `Broken images (naturalWidth=0): ${imgsBroken.length}.`, imgsBroken.map(describeEl));
        add("anchor-text",
          !hasIssues,
          anchorStatus,
          anchorMessage,
          emptyAnchors.map(a => ({ text: getAnchorText(a).slice(0, 140), href: a.getAttribute('href') || a.href || '' })));
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
  
        // Calculate SEO grade
        function calculateGrade(checks) {
          if (checks.length === 0) return { grade: "N/A", score: 0, percentage: 0 };
          let passCount = 0, warnCount = 0, failCount = 0;
          for (const check of checks) {
            if (check.severity === "pass") passCount++;
            else if (check.severity === "warn") warnCount++;
            else if (check.severity === "fail") failCount++;
          }
          const totalPoints = passCount + (warnCount * 0.5);
          const maxPoints = checks.length;
          const percentage = maxPoints > 0 ? (totalPoints / maxPoints) * 100 : 0;
          // Grade assignment
          // A+ only if no fails AND no warns AND 95-100%
          // Otherwise use classic grading scale: A (90-100%), B (80-89%), C (70-79%), D (60-69%), F (0-59%)
          let grade;
          if (failCount === 0 && warnCount === 0 && percentage >= 95 && percentage <= 100) {
            grade = "A+";
          } else {
            // Classic grading scale
            if (percentage >= 90) grade = "A";
            else if (percentage >= 80) grade = "B";
            else if (percentage >= 70) grade = "C";
            else if (percentage >= 60) grade = "D";
            else grade = "F";
          }
          return {
            grade,
            score: Math.round(percentage),
            percentage: Math.round(percentage * 10) / 10,
            passCount,
            warnCount,
            failCount,
            totalChecks: checks.length
          };
        }
        const grade = calculateGrade(checks);
  
        return {
          report: {
            url, timestamp: Date.now(),
            summary: { title, metaDesc, canonical, robots, viewport, lang, words, textChars, htmlSize, urlStructure, hreflangs, structuredDataTypes, perf },
            checks,
            grade
          },
          linksSample: linkHrefs
        };
      },
      args: [initialUrl]
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
      if (!u || !/^https?:\/\//i.test(u)) return report;
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

      // Get existing checks and filter out any previous network checks to avoid duplicates
      // Network check IDs: 'links-audit', 'http-status', 'x-robots-tag', 'cache-headers', 'robots.txt'
      const existingChecks = report.report?.checks || report.checks || [];
      const networkCheckIds = ['links-audit', 'http-status', 'x-robots-tag', 'cache-headers', 'robots.txt'];
      const baseChecks = existingChecks.filter(check => !networkCheckIds.includes(check.id));
      
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

      // Create new checks array starting with base checks, then add network checks
      const checks = [...baseChecks];
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
      
      // Recalculate grade after adding new checks
      const reportObj = report.report || report;
      function calculateGrade(checks) {
        if (checks.length === 0) return { grade: "N/A", score: 0, percentage: 0 };
        let passCount = 0, warnCount = 0, failCount = 0;
        for (const check of checks) {
          if (check.severity === "pass") passCount++;
          else if (check.severity === "warn") warnCount++;
          else if (check.severity === "fail") failCount++;
        }
        const totalPoints = passCount + (warnCount * 0.5);
        const maxPoints = checks.length;
        const percentage = maxPoints > 0 ? (totalPoints / maxPoints) * 100 : 0;
        // Grade assignment
        // A+ only if no fails AND no warns AND 95-100%
        // Otherwise use classic grading scale: A (90-100%), B (80-89%), C (70-79%), D (60-69%), F (0-59%)
        let grade;
        if (failCount === 0 && warnCount === 0 && percentage >= 95 && percentage <= 100) {
          grade = "A+";
        } else {
          // Classic grading scale
          if (percentage >= 90) grade = "A";
          else if (percentage >= 80) grade = "B";
          else if (percentage >= 70) grade = "C";
          else if (percentage >= 60) grade = "D";
          else grade = "F";
        }
        return {
          grade,
          score: Math.round(percentage),
          percentage: Math.round(percentage * 10) / 10,
          passCount,
          warnCount,
          failCount,
          totalChecks: checks.length
        };
      }
      reportObj.grade = calculateGrade(checks);
    } catch {}
    return report;
  }
  
  // Helper to get CSS class for grade
  function getGradeClass(grade) {
    if (!grade || grade === "N/A") return "grade-na";
    const firstChar = grade.charAt(0);
    if (firstChar === "A") return "grade-a";
    if (firstChar === "B") return "grade-b";
    if (firstChar === "C") return "grade-c";
    if (firstChar === "D") return "grade-d";
    return "grade-f"; // F or other
  }
  
  // Store current report for recommendations
  window.currentReport = null;

  async function render(res) {
    const scoreDisplayEl = document.getElementById("score-display");
    const statusBadgesEl = document.getElementById("status-badges");
    const urlEl = document.getElementById("url");
    const checksEl = document.getElementById("checks");
  
    if (!res || !res.report) {
      scoreDisplayEl.innerHTML = "";
      statusBadgesEl.innerHTML = "";
      urlEl.textContent = "This page can't be analyzed.";
      checksEl.innerHTML = "";
      window.currentReport = null;
      return;
    }
    const report = res.report;
    window.currentReport = report;
    
    // Display SEO Score with Grade
    if (report.grade) {
      const grade = report.grade;
      const gradeClass = getGradeClass(grade.grade);
      scoreDisplayEl.innerHTML = `
        <div class="score-with-grade">
          <div class="grade-letter-large ${gradeClass}">${grade.grade}</div>
          <div class="score-content">
            <div class="score-label">SEO Score</div>
            <div class="score-value">${grade.score} / 100</div>
            <div class="score-progress">
              <div class="score-progress-bar ${gradeClass}" style="width: ${grade.score}%"></div>
            </div>
          </div>
        </div>
      `;
      
      // Status badges
      statusBadgesEl.innerHTML = `
        <span class="badge ${grade.passCount > 0 ? 'success' : 'neutral'}">${grade.passCount} Pass</span>
        <span class="badge ${grade.warnCount > 0 ? 'warning' : 'neutral'}">${grade.warnCount} Warn</span>
        <span class="badge ${grade.failCount > 0 ? 'fail' : 'neutral'}">${grade.failCount} Fail</span>
      `;
    } else {
      scoreDisplayEl.innerHTML = "";
      statusBadgesEl.innerHTML = "";
    }
    
    // Get actual tab URL to avoid iframe/redirect issues - always prefer tab URL
    let displayUrl = report.url;
    try {
      const tab = await activeTab();
      if (tab && tab.url) {
        displayUrl = tab.url.split("#")[0];
      }
    } catch {}
    
    // Prefer canonical URL if available, otherwise use displayUrl
    displayUrl = report.summary?.canonical || displayUrl;
    urlEl.textContent = displayUrl;
  
    checksEl.textContent = "";
    const CHECK_INFO = {
      "title-length": { tip: "Keep titles ~45-70 chars; front-load primary keyword.", link: "https://developers.google.com/search/docs/appearance/title-link" },
      "meta-description": { tip: "Summarize page ~120-160 chars; unique per page.", link: "https://developers.google.com/search/docs/appearance/description" },
      "h1-count": { tip: "Use a single clear H1 per page.", link: "https://web.dev/learn/html/headings-and-sections/" },
      "heading-hierarchy": { tip: "Avoid jumps (H2→H4). Step levels logically.", link: "https://web.dev/learn/html/headings-and-sections/" },
      "canonical": { tip: "Add <link rel=\"canonical\"> to the preferred URL.", link: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls" },
      "noindex": { tip: "Remove noindex to allow page indexing.", link: "https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag" },
      "nofollow": { tip: "Remove nofollow to allow link following.", link: "https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag" },
      "viewport": { tip: "Include responsive viewport for mobile.", link: "https://developer.mozilla.org/docs/Web/HTML/Viewport_meta_tag" },
      "lang": { tip: "Set <html lang> for accessibility and SEO.", link: "https://developer.mozilla.org/docs/Web/HTML/Global_attributes/lang" },
      "image-alt": { tip: "Describe images with concise alt text.", link: "https://web.dev/learn/accessibility/semantic-html/images/" },
      "image-broken": { tip: "Fix broken image URLs or hosting issues.", link: "" },
      "anchor-text": { tip: "Use varied anchor text (branded, generic, partial match), keep exact-match ≤5%, aim for ≥50% descriptive, balance internal/external links.", link: "https://developers.google.com/search/docs/appearance/links" },
      "open-graph": { tip: "Add OG tags for social sharing.", link: "https://ogp.me/" },
      "twitter-card": { tip: "Add Twitter Card meta tags.", link: "https://developer.twitter.com/en/docs/twitter-for-websites/cards/overview/abouts-cards" },
      "url-structure": { tip: "Use clean, lowercase URLs without underscores.", link: "" },
      "content-length": { tip: "Ensure sufficient depth to cover the topic.", link: "" },
      "keyword-density": { tip: "Focus on topics; avoid stuffing.", link: "" },
      "hreflang": { tip: "Declare alternates with correct hreflang codes.", link: "https://developers.google.com/search/docs/specialty/international/localized-versions" },
      "structured-data": { tip: "Add relevant schema.org types.", link: "https://developers.google.com/search/docs/appearance/structured-data" },
      "links-audit": { tip: "Fix broken links; prefer descriptive internal links.", link: "" },
      "http-status": { tip: "Aim for 200; fix non-2xx issues.", link: "" },
      "x-robots-tag": { tip: "Avoid noindex unless intentional.", link: "" },
      "cache-headers": { tip: "Set sensible cache-control for performance.", link: "" },
      "robots.txt": { tip: "Allow important pages; block only necessary paths.", link: "" }
    };

    for (const c of report.checks) {
      const div = document.createElement("div");
      div.className = `check ${sevClass(c.severity)}`;

      // Parameter name
      const paramDiv = document.createElement("div");
      paramDiv.className = "check-parameter";
      let paramText = c.id.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      // Capitalize HTTP specifically
      paramText = paramText.replace(/\bHttp\b/gi, 'HTTP');
      // Keep robots.txt lowercase
      paramText = paramText.replace(/\bRobots\.Txt\b/gi, 'robots.txt');
      const paramTextSpan = document.createElement("span");
      paramTextSpan.textContent = paramText;
      paramDiv.appendChild(paramTextSpan);
      
      // Details container (created early to hold info box)
      const detailsDiv = document.createElement("div");
      detailsDiv.className = "check-details";
      
      // Info button
      const info = CHECK_INFO[c.id];
      let infoBox = null;
      if (info) {
        const infoBtn = document.createElement("button");
        infoBtn.type = "button";
        infoBtn.className = "info-btn";
        infoBtn.textContent = "i";
        infoBtn.title = "More information";
        infoBox = document.createElement("div");
        infoBox.className = "info-box small";
        infoBox.textContent = info.tip + (info.link? ` `: ``);
        if (info.link) {
          const a = document.createElement("a");
          a.href = info.link;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = "Learn more";
          infoBox.appendChild(a);
        }
        infoBtn.addEventListener('click', () => {
          infoBox.classList.toggle('active');
        });
        paramDiv.appendChild(infoBtn);
        detailsDiv.appendChild(infoBox);
      }
      div.appendChild(paramDiv);

      // Value
      const valueDiv = document.createElement("div");
      valueDiv.className = "check-value";
      
      // Format message for better display - split long messages
      if (c.id === 'meta-description' && c.message) {
        // Parse meta description message to display it nicely
        const messageParts = c.message.split(' | ');
        messageParts.forEach((part, idx) => {
          if (idx > 0) {
            const br = document.createElement('br');
            valueDiv.appendChild(br);
          }
          const span = document.createElement('span');
          // Clean up the message (remove trailing period if standalone)
          let cleanPart = part.trim();
          // Remove trailing period only if it's not part of quoted text
          if (cleanPart.endsWith('.') && !cleanPart.match(/^[^"]*"[^"]*"\.$/)) {
            cleanPart = cleanPart.slice(0, -1);
          }
          span.textContent = cleanPart;
          valueDiv.appendChild(span);
        });
      } else {
        valueDiv.textContent = c.message;
      }
      
      // Add "Elements flagged" to value column for h1-count and image-alt checks
      if ((c.id === 'h1-count' || c.id === 'image-alt') && c.where && c.where.length) {
        const count = document.createElement("div");
        count.className = "small";
        count.textContent = `Elements flagged: ${c.where.length}`;
        valueDiv.appendChild(count);
      }

      // Add highlight button for anchor-text check (below value text)
      if (c.id === 'anchor-text') {
        const actions = document.createElement('div');
        actions.className = 'check-actions';
        
        // Add "Elements flagged" text next to the button
        if (c.where && c.where.length) {
          const count = document.createElement("span");
          count.className = "small";
          count.textContent = `Elements flagged: ${c.where.length}`;
          actions.appendChild(count);
        }
        
        const highlightBtn = document.createElement('button');
        highlightBtn.type = 'button';
        highlightBtn.textContent = 'Highlight on page';
        highlightBtn.addEventListener('click', async () => {
          try {
            const tab = await activeTab();
            if (!tab) return;
            
            // Collect problematic anchor data from the report
            const problematicAnchors = c.where || [];
            const anchorData = problematicAnchors.map(a => {
              try {
                // Handle both Element objects and serialized objects
                if (typeof a === 'object' && a !== null) {
                  // Try to get href and text from element-like object
                  const href = a.href || (a.getAttribute && a.getAttribute('href')) || '';
                  const text = (a.textContent || a.innerText || '').trim();
                  const innerHTML = a.innerHTML || '';
                  
                  return {
                    href: typeof href === 'string' ? href : '',
                    text: typeof text === 'string' ? text : '',
                    innerHTML: typeof innerHTML === 'string' ? innerHTML : ''
                  };
                }
                return null;
              } catch (e) {
                console.warn('[SEO Scout] Error extracting anchor data:', e);
                return null;
              }
            }).filter(Boolean);
            
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id, allFrames: true },
              args: [anchorData],
              func: (anchorData) => {
                const styleId = '__seo_scout_highlight__';
                if (!document.getElementById(styleId)) {
                  const st = document.createElement('style');
                  st.id = styleId;
                  st.textContent = `.seo-scout-highlight{outline:2px solid #ea4335 !important; outline-offset:10px !important; box-shadow: 12px 0 0 0 rgba(234, 67, 53, 0.6), -12px 0 0 0 rgba(234, 67, 53, 0.6) !important; margin: -4px 0 !important; padding: 2px 0 !important;}`;
                  document.documentElement.appendChild(st);
                }
                const flagAttr = 'data-seo-scout-highlight';
                const isActive = document.documentElement.getAttribute(flagAttr) === '1';
                
                // Helper to get anchor text (text content or image alt)
                function getAnchorText(anchor) {
                  const text = (anchor.textContent || "").trim();
                  if (text.length > 0) return text;
                  const img = anchor.querySelector('img');
                  if (img) {
                    const alt = (img.getAttribute('alt') || "").trim();
                    if (alt.length > 0) return alt;
                  }
                  return "";
                }
                
                // Helper to check if should exclude from highlighting
                function shouldExclude(anchor) {
                  const t = getAnchorText(anchor);
                  
                  // Exclude anchors with media elements (images, audio, video, logos)
                  const hasImg = anchor.querySelector('img') !== null;
                  const hasAudio = anchor.querySelector('audio') !== null;
                  const hasVideo = anchor.querySelector('video') !== null;
                  if (hasImg || hasAudio || hasVideo) return true;
                  
                  // Exclude anchors that are in containers with media elements (e.g., siblings of audio/video/images)
                  let parent = anchor.parentElement;
                  while (parent && parent !== document.body) {
                    if (parent.querySelector('img') || parent.querySelector('audio') || parent.querySelector('video')) {
                      return true;
                    }
                    parent = parent.parentElement;
                  }
                  
                  // Exclude anchors with avatar/image-related classes
                  const className = anchor.className || '';
                  const avatarClasses = /(avatar|main-avatar|user-avatar|profile-picture|profile-image|user-image)/i;
                  if (avatarClasses.test(className)) return true;
                  
                  // Exclude logo/brand links (common in headers)
                  const logoBrandClasses = /(logo|brand|site-logo|brand-logo|company-logo|header-logo)/i;
                  if (logoBrandClasses.test(className)) return true;
                  
                  // Check parent containers for navigation context
                  let parentNav = anchor.parentElement;
                  const navContexts = ['nav', 'header', '.navigation', '.nav', '.breadcrumb', '.breadcrumbs', '.menu'];
                  while (parentNav && parentNav !== document.body) {
                    const parentTag = parentNav.tagName?.toLowerCase() || '';
                    const parentClass = parentNav.className || '';
                    const parentRole = parentNav.getAttribute?.('role') || '';
                    if (navContexts.some(ctx => 
                      parentTag === ctx.replace('.', '') || 
                      (ctx.startsWith('.') && parentClass.includes(ctx.replace('.', ''))) ||
                      parentRole === 'navigation'
                    )) {
                      // In navigation context - exclude common nav links and logo links
                      const commonNavLinks = /^(home|faq|about|contact|blog|news|products|services|support|help|login|sign|search|menu)$/i;
                      if (commonNavLinks.test(t)) return true;
                      // Also exclude logo links in header/nav
                      if (hasImg || logoBrandClasses.test(className)) return true;
                    }
                    parentNav = parentNav.parentElement;
                  }
                  
                  // Exclude common navigation links (even outside nav elements)
                  const commonNavLinks = /^(home|faq|about|contact|blog|news|products|services|support|help|login|sign|search|menu)$/i;
                  if (commonNavLinks.test(t) && t.length <= 20) return true;
                  
                  // Exclude anchors with media player control classes
                  const mediaControlClasses = /(mw-tmh|media-player|audio-player|video-player|play-button|media-control)/i;
                  if (mediaControlClasses.test(className)) return true;
                  
                  // Exclude links to media files
                  const href = anchor.getAttribute('href') || '';
                  const mediaExts = /\.(mp3|mp4|wav|ogg|webm|avi|mov|wmv|flv|m4a|aac|wma|pdf|zip|rar|exe|dmg)$/i;
                  if (mediaExts.test(href)) return true;
                  
                  // Exclude anchors with "Play audio/video" type titles
                  const title = anchor.getAttribute('title') || '';
                  if (/\b(play|audio|video|sound|media)\b/i.test(title) && t.length <= 20) return true;
                  
                  // Exclude purely numeric anchors
                  if (/^\d+$/.test(t)) return true;
                  
                  // Exclude very short symbols/non-English
                  if (t.length <= 2) {
                    if (/^[\d\s\W]+$/.test(t)) return true;
                    if (t.length === 1 && /[^\x00-\x7F]/.test(t)) return true;
                  }
                  
                  return false;
                }
                
                const anchors = [...document.querySelectorAll('a[href]')];
                
                // If we have anchor data from the report, use it to match anchors
                let targets = [];
                if (anchorData && anchorData.length > 0) {
                  targets = anchors.filter(a => {
                    const aHref = a.href || '';
                    const aText = (a.textContent || "").trim();
                    
                    // Match anchors by text content (primary) and href (secondary)
                    return anchorData.some(data => {
                      // Primary match: text content matches exactly
                      if (data.text && aText === data.text) {
                        // If href is provided, prefer matching it too, but text match is sufficient
                        if (data.href) {
                          return aHref === data.href || !data.href || aHref.endsWith(data.href);
                        }
                        return true;
                      }
                      
                      // Secondary match: href matches (for empty anchors)
                      if (data.href && aHref === data.href && !data.text) {
                        return true;
                      }
                      
                      // Match by innerHTML if text doesn't match (for anchors with HTML)
                      if (data.innerHTML && a.innerHTML === data.innerHTML) {
                        return true;
                      }
                      
                      return false;
                    });
                  });
                } else {
                  // Fallback: use heuristics if no anchor data provided
                  targets = anchors.filter(a => {
                    // First check exclusions
                    if (shouldExclude(a)) return false;
                    
                    const t = getAnchorText(a);
                    
                    // Empty anchors (no text, no image, or image without alt)
                    if (t.length === 0) {
                      // Double-check: truly empty if no text content AND (no image OR image without alt)
                      const textContent = (a.textContent || "").trim();
                      const hasImg = a.querySelector('img') !== null;
                      if (textContent.length === 0 && (!hasImg || !a.querySelector('img[alt]')?.getAttribute('alt')?.trim())) {
                        return true;
                      }
                      return false;
                    }
                    
                    // Very short anchors (1-3 chars)
                    if (t.length > 0 && t.length <= 3) {
                      return true;
                    }
                    
                    // Check for common weak anchor text patterns
                    const weakPatterns = [
                      /^(click|here|more|link|this|page|go|ok)$/i,
                      /^(read|learn|see|view|download|get|buy|shop).*more?$/i,
                      /^#[a-z0-9]+$/i, // Just hash links
                      /^(javascript|#|void\s*\(0?\))/i // JavaScript or empty links
                    ];
                    
                    if (weakPatterns.some(pattern => pattern.test(t))) {
                      return true;
                    }
                    
                    return false;
                  });
                }
                if (isActive) {
                  targets.forEach(a => a.classList.remove('seo-scout-highlight'));
                  document.documentElement.removeAttribute(flagAttr);
                  return 'off';
                } else {
                  targets.forEach(a => a.classList.add('seo-scout-highlight'));
                  document.documentElement.setAttribute(flagAttr, '1');
                  return 'on';
                }
              }
            });
            const state = results && results[0] && results[0].result;
            if (state === 'on') highlightBtn.textContent = 'Clear highlights';
            else if (state === 'off') highlightBtn.textContent = 'Highlight on page';
          } catch {}
        });
        actions.appendChild(highlightBtn);
        valueDiv.appendChild(actions);
      }
      
      div.appendChild(valueDiv);

      // Status
      const statusDiv = document.createElement("div");
      statusDiv.className = `check-status ${sevClass(c.severity)}`;
      const statusIcon = document.createElement("span");
      statusIcon.className = `status-icon ${sevClass(c.severity)}`;
      statusIcon.textContent = c.severity === "pass" ? "✓" : c.severity === "warn" ? "!" : "×";
      statusDiv.appendChild(statusIcon);
      const statusText = c.severity === "pass" ? "OK" : c.severity === "warn" ? "Warn" : "Fail";
      const statusTextSpan = document.createElement("span");
      statusTextSpan.className = `status-text ${sevClass(c.severity)}`;
      statusTextSpan.textContent = statusText;
      statusDiv.appendChild(statusTextSpan);
      div.appendChild(statusDiv);
      
      // Add details to detailsDiv (skip h1-count and image-alt as they're in value column, and anchor-text has it in actions)
      if (c.where && c.where.length && c.id !== 'h1-count' && c.id !== 'image-alt' && c.id !== 'anchor-text') {
        const count = document.createElement("div");
        count.className = "small";
        count.textContent = `Elements flagged: ${c.where.length}`;
        detailsDiv.appendChild(count);
      }
      
      // Append details if it has content
      if (detailsDiv.children.length > 0) {
        div.appendChild(detailsDiv);
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
          diffDiv.className = "check-diff pass";
          const delta = now.checks - (prev.checks || 0);
          diffDiv.textContent = `Changes since last run: checks ${prev.checks||0} → ${now.checks} (${delta>=0?'+':''}${delta})`;
          checksEl.prepend(diffDiv);
        }
        chrome.storage.local.set({ [key]: now });
      });
    } catch {}
  }
  
  async function getOpenAIKey() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['openai_api_key'], (result) => {
        resolve(result.openai_api_key || null);
      });
    });
  }

  async function saveOpenAIKey(key) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ openai_api_key: key }, () => {
        resolve();
      });
    });
  }

  // Cache recommendations to avoid repeated API calls
  function getCacheKey(report) {
    const issues = report.checks
      .filter(c => c.severity === 'fail' || c.severity === 'warn')
      .map(c => `${c.id}:${c.severity}`)
      .sort()
      .join('|');
    return `rec_cache:${report.url}:${issues}`;
  }

  async function getCachedRecommendations(report) {
    const cacheKey = getCacheKey(report);
    return new Promise((resolve) => {
      chrome.storage.local.get([cacheKey], (result) => {
        const cached = result[cacheKey];
        if (cached && cached.timestamp) {
          // Cache valid for 24 hours
          const age = Date.now() - cached.timestamp;
          if (age < 24 * 60 * 60 * 1000) {
            resolve(cached.data);
            return;
          }
        }
        resolve(null);
      });
    });
  }

  async function saveCachedRecommendations(report, data) {
    const cacheKey = getCacheKey(report);
    return new Promise((resolve) => {
      chrome.storage.local.set({
        [cacheKey]: {
          data: data,
          timestamp: Date.now()
        }
      }, () => {
        resolve();
      });
    });
  }

  // Rate limiting - track last request time
  async function getLastRequestTime() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['last_ai_request'], (result) => {
        resolve(result.last_ai_request || 0);
      });
    });
  }

  async function setLastRequestTime() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ last_ai_request: Date.now() }, () => {
        resolve();
      });
    });
  }

  // Check if enough time has passed since last request (60 second cooldown)
  async function canMakeRequest() {
    const lastRequest = await getLastRequestTime();
    const now = Date.now();
    const cooldownMs = 60000; // 60 seconds
    const timeSinceLastRequest = now - lastRequest;
    return {
      canRequest: timeSinceLastRequest >= cooldownMs,
      waitTime: Math.max(0, cooldownMs - timeSinceLastRequest)
    };
  }

  // Extract website context from report for personalized recommendations
  function getWebsiteContext(report) {
    const url = report.url || report.report?.url || '';
    let domain = '';
    try {
      if (url) {
        const urlObj = new URL(url);
        domain = urlObj.hostname.replace(/^www\./, '');
      }
    } catch (e) {}
    
    // Extract page content from checks for context
    let title = '';
    let metaDesc = '';
    let h1 = '';
    let pageType = 'page'; // Default to 'page', could be 'home', 'blog', 'product', etc.
    
    const titleCheck = report.checks?.find(c => c.id === 'title-length');
    if (titleCheck?.message) {
      // Try to extract actual title from message - format: "Title length: 35 | Title: \"Welcome\""
      // Match the quoted title: Title: "text"
      const quotedTitleMatch = titleCheck.message.match(/Title:\s*"([^"]+)"/i);
      if (quotedTitleMatch) {
        title = quotedTitleMatch[1].trim();
      } else {
        // Fallback: try without quotes
        const titleMatch = titleCheck.message.match(/Title:\s*(.+?)(?:\s*\(|$)/i);
        if (titleMatch) {
          title = titleMatch[1].trim();
        }
      }
    }
    
    // Also try to get from report summary if available
    if (!title && report.summary?.title) {
      title = report.summary.title;
    }
    
    const metaCheck = report.checks?.find(c => c.id === 'meta-description');
    if (metaCheck?.message) {
      const lengthMatch = metaCheck.message.match(/Meta description length:\s*(\d+)/i);
      if (lengthMatch && parseInt(lengthMatch[1]) > 0) {
        // Meta description exists, try to extract it - format: "Description: \"text\""
        const quotedDescMatch = metaCheck.message.match(/Description:\s*"([^"]+)"/i);
        if (quotedDescMatch) {
          metaDesc = quotedDescMatch[1].trim();
        } else {
          // Fallback: try without quotes
          const descMatch = metaCheck.message.match(/Description:\s*(.+?)(?:\s*\(|$)/i) || metaCheck.message.match(/Meta description:\s*(.+?)(?:\s*\(|$)/i);
          if (descMatch) {
            metaDesc = descMatch[1].trim();
          }
        }
      }
    }
    
    // Also try to get from report summary if available
    if (!metaDesc && report.summary?.metaDesc) {
      metaDesc = report.summary.metaDesc;
    }
    
    const h1Check = report.checks?.find(c => c.id === 'h1-count');
    if (h1Check) {
      // Try to infer page type from H1 or URL
      if (url.includes('/blog/') || url.includes('/article/')) pageType = 'blog';
      else if (url.includes('/product/') || url.includes('/shop/')) pageType = 'product';
      else if (url === `https://${domain}/` || url === `https://${domain}` || url === `http://${domain}/` || url === `http://${domain}`) pageType = 'home';
    }
    
    return { domain, url, title, metaDesc, h1, pageType };
  }

  // Rule-based recommendations (no API needed - works instantly)
  function getRuleBasedRecommendations(report) {
    const issues = report.checks.filter(c => c.severity === 'fail' || c.severity === 'warn');
    if (issues.length === 0) {
      return null;
    }

    // Get website context for personalized recommendations
    const websiteContext = getWebsiteContext(report);

    // Rule-based recommendations for each SEO issue
    const recommendationRules = {
      'title-length': (check, context) => {
        const match = check.message.match(/(\d+)/);
        const length = match ? parseInt(match[1]) : 0;
        // Extract title from context or message
        let currentTitle = context.title || '';
        if (!currentTitle) {
          // Try to extract from message: "Title: \"text\""
          const quotedMatch = check.message.match(/Title:\s*"([^"]+)"/i);
          if (quotedMatch) {
            currentTitle = quotedMatch[1].trim();
          } else {
            // Fallback
            const titleMatch = check.message.match(/Title:\s*(.+?)(?:\s*\(|$)/i);
            if (titleMatch) {
              currentTitle = titleMatch[1].trim();
            }
          }
        }
        const domain = context.domain || '';
        
        if (length < 45) {
          // Create personalized example based on current title and domain
          let example = '';
          // Always show an example if domain is available, even without current title
          if (currentTitle && currentTitle.trim()) {
            // Enhance existing title - try multiple approaches
            let enhanced = '';
            if (currentTitle.length < 20) {
              // Very short title - add domain and value proposition
              const domainName = domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : 'YourSite';
              enhanced = `${currentTitle} - ${domainName} | Premium Services & Quality`;
            } else if (currentTitle.length < 35) {
              // Medium title - add domain/brand
              const domainName = domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : '';
              enhanced = domainName ? `${currentTitle} | ${domainName}` : currentTitle + ' | Quality & Trust';
            } else {
              // Close to target - just add a bit more
              enhanced = currentTitle + ' | Best Choice';
            }
            
            // Ensure example is in target range, otherwise adjust
            if (enhanced.length < 45) {
              enhanced = enhanced + ' - Learn More';
            }
            if (enhanced.length > 70) {
              // Trim to fit
              const words = enhanced.split(' ');
              enhanced = words.slice(0, Math.min(words.length - 1, 10)).join(' ');
            }
            
            if (enhanced.length >= 45 && enhanced.length <= 70) {
              example = ` Example: "${enhanced}" (${enhanced.length} chars)`;
            } else if (domain) {
              // Fallback to domain-based example
              const pageType = context.pageType === 'home' ? 'Home' : context.pageType === 'blog' ? 'Blog' : context.pageType === 'product' ? 'Product' : 'Services';
              const domainName = domain.charAt(0).toUpperCase() + domain.slice(1);
              example = ` Example: "${domainName} - ${pageType} | Premium Quality & Trust"`;
            }
          }
          
          // Always show domain-based example if domain is available (even without current title)
          if (!example && domain) {
            const pageType = context.pageType === 'home' ? 'Home' : context.pageType === 'blog' ? 'Blog' : context.pageType === 'product' ? 'Product' : 'Services';
            const domainName = domain.charAt(0).toUpperCase() + domain.slice(1);
            example = ` Example: "${domainName} - ${pageType} | Premium Quality & Trust"`;
          }
          
          return {
            title: 'Title Too Short',
            recommendation: `Your title is ${length} characters, but should be 45-70 characters for optimal SEO. Add more descriptive keywords while keeping it concise and compelling. Include your primary keyword near the beginning.${example}`
          };
        } else if (length > 70) {
          // Suggest shortening
          let suggestion = '';
          if (currentTitle) {
            const words = currentTitle.split(' ');
            // Try to suggest a shorter version
            if (words.length > 10) {
              const shortened = words.slice(0, 10).join(' ');
              suggestion = shortened.length >= 45 && shortened.length <= 70 
                ? ` Consider: "${shortened}" (${shortened.length} chars)`
                : '';
            }
          }
          
          return {
            title: 'Title Too Long',
            recommendation: `Your title is ${length} characters, but should be 45-70 characters. Search engines typically truncate titles over 70 characters. Shorten it by removing unnecessary words while keeping the most important keywords.${suggestion}`
          };
        }
        return null;
      },
      'meta-description': (check, context) => {
        const match = check.message.match(/(\d+)/);
        const length = match ? parseInt(match[1]) : 0;
        // Extract meta description from context or message
        let currentDesc = context.metaDesc || '';
        if (!currentDesc) {
          // Try to extract from message: "Description: \"text\""
          const quotedMatch = check.message.match(/Description:\s*"([^"]+)"/i);
          if (quotedMatch) {
            currentDesc = quotedMatch[1].trim();
          } else {
            // Fallback
            const descMatch = check.message.match(/Description:\s*(.+?)(?:\s*\(|$)/i);
            if (descMatch) {
              currentDesc = descMatch[1].trim();
            }
          }
        }
        const domain = context.domain || '';
        const pageType = context.pageType || 'page';
        
        if (length === 0) {
          // Generate personalized example based on domain and page type
          let example = '';
          if (domain) {
            const domainName = domain.charAt(0).toUpperCase() + domain.slice(1);
            const pageName = pageType === 'home' ? 'homepage' : pageType === 'blog' ? 'blog' : pageType === 'product' ? 'product page' : 'page';
            example = ` Example: <meta name="description" content="Discover ${domainName}'s premium ${pageName} offerings. Experience quality, trust, and excellence. Learn more about our services and start your journey today.">`;
          } else {
            example = ' Example: <meta name="description" content="Your compelling 120-160 character description here">';
          }
          
          return {
            title: 'Missing Meta Description',
            recommendation: `Add a meta description tag in your HTML head section. It should be 120-160 characters, include your primary keyword, and provide a compelling summary that encourages clicks.${example}`
          };
        } else if (length < 120) {
          // Suggest expansion based on current description
          let suggestion = '';
          if (currentDesc && currentDesc.trim().length > 0) {
            const preview = currentDesc.length > 40 ? currentDesc.substring(0, 40) + '...' : currentDesc;
            suggestion = ` Expand your current description "${preview}" with more details about benefits, features, and a compelling call-to-action.`;
          } else if (domain) {
            const domainName = domain.charAt(0).toUpperCase() + domain.slice(1);
            suggestion = ` Add details about ${domainName}'s key benefits, unique value propositions, and encourage users to take action (e.g., "Learn more", "Get started today", "Discover why").`;
          }
          
          return {
            title: 'Meta Description Too Short',
            recommendation: `Your meta description is ${length} characters. Expand it to 120-160 characters to provide more context and include a call-to-action. This improves click-through rates from search results.${suggestion}`
          };
        } else if (length > 160) {
          return {
            title: 'Meta Description Too Long',
            recommendation: `Your meta description is ${length} characters and may be truncated in search results. Shorten it to 120-160 characters to ensure the full message is visible to users. Focus on the most important keywords and value propositions.`
          };
        }
        return null;
      },
      'h1-count': (check) => {
        const match = check.message.match(/(\d+)/);
        const count = match ? parseInt(match[1]) : 0;
        if (count === 0) {
          return {
            title: 'Missing H1 Tag',
            recommendation: 'Add a single H1 tag to your page containing your primary keyword. The H1 should describe the main topic of the page and help search engines understand your content structure.'
          };
        } else {
          return {
            title: 'Multiple H1 Tags',
            recommendation: `You have ${count} H1 tags, but should have exactly one per page. Convert extra H1s to H2 or H3 tags to maintain proper heading hierarchy. The single H1 should represent the main topic of the page.`
          };
        }
      },
      'heading-hierarchy': (check) => ({
        title: 'Heading Hierarchy Issue',
        recommendation: check.message + ' Ensure headings follow a logical order (H1 → H2 → H3, etc.) without skipping levels. This helps search engines understand your content structure and improves accessibility.'
      }),
      'canonical': (check, context) => {
        const url = context.url || '';
        let example = '';
        if (url) {
          try {
            const urlObj = new URL(url);
            const cleanUrl = urlObj.href.split('?')[0].split('#')[0];
            example = ` Example: <link rel="canonical" href="${cleanUrl}">`;
          } catch (e) {
            example = ' Example: <link rel="canonical" href="https://yoursite.com/page-url">';
          }
        } else {
          example = ' Example: <link rel="canonical" href="https://yoursite.com/page-url">';
        }
        
        return {
          title: 'Missing Canonical Tag',
          recommendation: `Add a canonical tag to prevent duplicate content issues. Include a canonical tag in your HTML head that points to the preferred version of this page. This tells search engines which version of the page is the primary one.${example}`
        };
      },
      'noindex': (check) => ({
        title: 'Page Blocked by Noindex',
        recommendation: 'Your page has a noindex directive in the meta robots tag, which prevents search engines from indexing it. Remove noindex from <meta name="robots" content="..."> if you want this page to appear in search results. Only use noindex for pages you intentionally want to exclude from search.'
      }),
      'nofollow': (check) => ({
        title: 'Links Blocked by Nofollow',
        recommendation: 'Your page has a nofollow directive in the meta robots tag, which prevents search engines from following links on this page. Remove nofollow from <meta name="robots" content="..."> if you want links to be crawled. Only use nofollow if you intentionally want to prevent link following.'
      }),
      'viewport': (check) => ({
        title: 'Missing Viewport Meta Tag',
        recommendation: 'Add a viewport meta tag for mobile responsiveness: <meta name="viewport" content="width=device-width, initial-scale=1">. This is essential for mobile SEO as Google uses mobile-first indexing.'
      }),
      'lang': (check) => ({
        title: 'Missing Language Attribute',
        recommendation: 'Add a lang attribute to your HTML tag: <html lang="en"> (replace "en" with your page\'s language code). This helps search engines understand the page language and improves international SEO.'
      }),
      'image-alt': (check) => {
        const match = check.message.match(/(\d+)\/(\d+)/);
        if (match) {
          const missing = parseInt(match[1]);
          const total = parseInt(match[2]);
          return {
            title: 'Images Missing Alt Text',
            recommendation: `${missing} out of ${total} images are missing alt text. Add descriptive alt attributes to all images: <img src="image.jpg" alt="Descriptive text">. Alt text improves accessibility and helps images rank in image search.`
          };
        }
        return {
          title: 'Images Missing Alt Text',
          recommendation: 'Some images are missing alt text attributes. Add descriptive alt text to all images for accessibility and SEO. Alt text should describe the image content or purpose.'
        };
      },
      'image-broken': (check) => {
        const match = check.message.match(/(\d+)/);
        const broken = match ? parseInt(match[1]) : 0;
        if (broken > 0) {
          return {
            title: 'Broken Images Found',
            recommendation: `${broken} broken image(s) detected. Fix broken image URLs by checking image paths, file names, and hosting. Broken images hurt user experience and can negatively impact SEO. Ensure all image files exist and are accessible, or remove/replace broken images with working alternatives.`
          };
        }
        return null;
      },
      'anchor-text': (check, context) => {
        const domain = context.domain || '';
        
        // Parse issues from the check message
        const issues = check.message.includes('Anchor text issues:') 
          ? check.message.split('Anchor text issues:')[1]?.split('.')[0]?.trim() || ''
          : '';
        
        // Extract specific metrics
        const exactMatchMatch = check.message.match(/(\d+\.?\d*)% exact-match/i);
        const exactMatchPercent = exactMatchMatch ? parseFloat(exactMatchMatch[1]) : 0;
        const descriptiveMatch = check.message.match(/Only (\d+\.?\d*)% descriptive/i);
        const descriptivePercent = descriptiveMatch ? parseFloat(descriptiveMatch[1]) : 0;
        
        let recommendation = 'Follow anchor text best practices:\n\n';
        
        // Provide specific recommendations based on issues
        if (issues.includes('empty')) {
          recommendation += '• Remove empty anchors or add descriptive text to all links.\n';
        }
        if (exactMatchPercent > 5) {
          recommendation += `• Reduce exact-match anchors from ${exactMatchPercent.toFixed(1)}% to ≤5%. Use branded, generic, and partial-match anchors instead for a natural backlink profile.\n`;
        }
        if (descriptivePercent < 50 && descriptivePercent > 0) {
          recommendation += `• Increase descriptive anchors from ${descriptivePercent.toFixed(1)}% to ≥50%. Make anchor text descriptive and relevant to the destination page content.\n`;
        }
        if (issues.includes('external links') || issues.includes('internal links')) {
          recommendation += '• Balance internal and external linking. Use internal links to map out your site structure and external links to build authority.\n';
        }
        if (issues.includes('variety')) {
          recommendation += '• Increase anchor text variety. Use a mix of branded names, generic phrases (like "click here"), and partial matches for a natural profile.\n';
        }
        
        // If no specific issues, provide general best practices
        if (!issues || issues.length === 0) {
          recommendation = 'Maintain anchor text best practices:\n\n';
          recommendation += '• Continue using varied anchor text (branded, generic, partial match)\n';
          recommendation += '• Keep exact-match anchors ≤5% of total\n';
          recommendation += '• Maintain ≥50% descriptive anchors\n';
          recommendation += '• Balance internal and external links\n';
        }
        
        const domainName = domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : '';
        const example = domainName 
          ? ` Example for ${domainName}: Use "Explore ${domainName}'s features" (branded), "Learn more" (generic), or "Check our pricing guide" (partial match) instead of overusing exact-match keywords.`
          : ' Example: Use branded names, generic phrases like "read more", and descriptive partial matches instead of overusing exact-match keywords.';
        
        return {
          title: issues ? 'Anchor Text Best Practices Issues' : 'Anchor Text Best Practices',
          recommendation: recommendation + example
        };
      },
      'open-graph': (check) => {
        // The check message format is: "Open Graph tags: X (missing core tags)" or "No Open Graph tags."
        // Always show all four core tags explicitly
        const tag1 = 'og:title';
        const tag2 = 'og:description';
        const tag3 = 'og:image';
        const tag4 = 'og:url';
        const allCoreTags = `${tag1}, ${tag2}, ${tag3}, and ${tag4}`;
        
        if (check.message.includes('No Open Graph') || check.message.includes('missing core tags')) {
          return {
            title: 'Missing Open Graph Tags',
            recommendation: `Add all four core Open Graph tags for social sharing: ${allCoreTags}. Add these meta tags to your page's <head> section:\n\n<meta property="${tag1}" content="Your page title">\n<meta property="${tag2}" content="Your page description">\n<meta property="${tag3}" content="Image URL">\n<meta property="${tag4}" content="Page URL">\n\nThese tags control how your page appears when shared on social media and are essential for proper social previews.`
          };
        }
        
        return {
          title: 'Open Graph Tags Need Improvement',
          recommendation: `Complete your Open Graph tags by ensuring all four core tags are present: ${allCoreTags}. Complete OG tags improve social media sharing appearance and can drive more traffic from social platforms.`
        };
      },
      'twitter-card': (check) => ({
        title: 'Missing Twitter Card Tags',
        recommendation: 'Add Twitter Card meta tags to improve how your content appears when shared on Twitter. Include tags like <meta name="twitter:card" content="summary">, <meta name="twitter:title" content="Title">, and <meta name="twitter:description" content="Description">.'
      }),
      'http-status': (check) => {
        const match = check.message.match(/status:\s*(\d+)/i);
        const status = match ? parseInt(match[1]) : 200;
        if (status >= 400 && status < 500) {
          const errorType = status === 404 ? 'Page Not Found' : status === 403 ? 'Forbidden' : status === 401 ? 'Unauthorized' : 'Client Error';
          return {
            title: `HTTP ${status} ${errorType}`,
            recommendation: `Your page returns HTTP ${status} status code. ${status === 404 ? 'The page was not found. Check the URL, ensure the page exists, or set up a redirect to a relevant page.' : status === 403 ? 'Access is forbidden. Check server permissions and ensure the page is publicly accessible for search engines.' : status === 401 ? 'Authentication is required. Make the page publicly accessible or remove authentication requirements.' : 'Fix the underlying issue or redirect to a working page.'} This prevents search engines from indexing the page and hurts user experience.`
          };
        } else if (status >= 500) {
          return {
            title: 'HTTP Server Error',
            recommendation: `Your page returns HTTP ${status} server error. Fix server-side issues, check hosting, database connections, or application errors. Server errors prevent search engines from indexing your page and severely hurt user experience.`
          };
        } else if (status >= 300 && status < 400) {
          // Redirects
          return {
            title: 'HTTP Redirect',
            recommendation: `Your page returns HTTP ${status} redirect. Ensure redirects are properly configured. Permanent redirects (301) pass SEO value to the new page, while temporary redirects (302) don't. Use 301 redirects for permanent moves.`
          };
        }
        return null; // 200 OK - no recommendation needed
      },
      'x-robots-tag': (check) => ({
        title: 'X-Robots-Tag Blocks Indexing',
        recommendation: 'Your HTTP response includes an X-Robots-Tag with noindex, which prevents search engines from indexing this page. Remove or modify the X-Robots-Tag header if you want this page to be indexed.'
      }),
      'cache-headers': (check) => ({
        title: 'Missing Cache Control Headers',
        recommendation: 'Add Cache-Control HTTP headers to improve page load speed. For static content, use: Cache-Control: public, max-age=31536000. For dynamic content, use shorter cache times. Faster pages rank better in search results.'
      }),
      'robots.txt': (check) => ({
        title: 'Blocked by robots.txt',
        recommendation: 'Your page is blocked in robots.txt. Remove the blocking rule if you want search engines to crawl this page. Check your robots.txt file and ensure this URL path is not disallowed.'
      }),
      'links-audit': (check) => {
        const brokenMatch = check.message.match(/Broken.*?:\s*(\d+)/i);
        const broken = brokenMatch ? parseInt(brokenMatch[1]) : 0;
        if (broken > 0) {
          return {
            title: 'Broken Links Found',
            recommendation: `${broken} broken link(s) detected. Fix or remove broken links as they hurt user experience and can negatively impact SEO. Use tools to find and fix 404 errors, or redirect broken URLs to relevant pages.`
          };
        }
        return null;
      }
    };

    const recommendations = [];
    for (const issue of issues) {
      const rule = recommendationRules[issue.id];
      if (rule) {
        const rec = rule(issue, websiteContext);
        if (rec) {
          recommendations.push({
            issue: issue.id,
            severity: issue.severity,
            title: rec.title,
            recommendation: rec.recommendation
          });
        }
      }
    }

    return recommendations.length > 0 ? { recommendations } : null;
  }

  // AI-enhanced recommendations using OpenAI (ChatGPT) - falls back to rule-based if no API key
  async function getAIRecommendations(report, onRetry = null) {
    // Try OpenAI (ChatGPT) if API key is configured
    const apiKey = await getOpenAIKey();
    
    // If no API key, fall back to rule-based recommendations
    if (!apiKey) {
      return getRuleBasedRecommendations(report);
    }

    // Filter to get only failed or warning checks
    const issues = report.checks.filter(c => c.severity === 'fail' || c.severity === 'warn');
    if (issues.length === 0) {
      return null;
    }

    // Start with rule-based recommendations (instant fallback)
    const ruleBasedRecs = getRuleBasedRecommendations(report);
    
    // Limit to 10 issues max to reduce token usage
    const limitedIssues = issues.slice(0, 10);

    // Format issues for AI with context
    const issuesText = limitedIssues.map(issue => {
      const existingRec = ruleBasedRecs?.recommendations?.find(r => r.issue === issue.id);
      return `- ${issue.id}: ${issue.message} (Status: ${issue.severity})${existingRec ? `\n  Current recommendation: ${existingRec.recommendation}` : ''}`;
    }).join('\n\n');

    // Get website context for AI prompt
    const websiteContext = getWebsiteContext(report);
    const websiteInfo = websiteContext.domain 
      ? `Website: ${websiteContext.domain}${websiteContext.url ? ` (${websiteContext.url})` : ''}${websiteContext.pageType ? ` | Page Type: ${websiteContext.pageType}` : ''}`
      : '';
    const pageContext = websiteContext.title 
      ? `Current Page Title: "${websiteContext.title}"` 
      : '';
    const contextInfo = [websiteInfo, pageContext].filter(Boolean).join('\n');
    
    const prompt = `You are an SEO expert. Analyze these SEO issues found on a website and provide specific, personalized, actionable recommendations tailored to this specific website.

Website Context:
${contextInfo || 'No specific context available'}

IMPORTANT: Make your recommendations highly personalized to this specific website. Include:
- Specific examples using the website's domain and current content when available
- Tailored code examples that match the website's structure
- Personalized suggestions based on the page type and current title/description
- Best practices specific to this website's industry/niche
- Actionable steps with website-specific examples

SEO Issues:
${issuesText}

Provide recommendations in JSON format:
{
  "recommendations": [
    {
      "issue": "issue-id",
      "severity": "fail|warn",
      "title": "Brief, actionable title",
      "recommendation": "Detailed, personalized recommendation with website-specific examples, tailored suggestions, and actionable best practices for THIS specific website"
    }
  ]
}`;

    // Retry logic with exponential backoff
    const maxRetries = 2;
    let lastError = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Add delay for retries
        if (attempt > 0) {
          const delayMs = Math.min(10000 * attempt, 30000); // 10s, 20s, 30s max
          if (onRetry) onRetry(attempt, maxRetries);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        // Check cooldown before making request
        const cooldown = await canMakeRequest();
        if (!cooldown.canRequest && attempt === 0) {
          // First attempt blocked by cooldown - use rule-based instead
          return ruleBasedRecs;
        }

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: 'gpt-3.5-turbo',
            messages: [
              {
                role: 'system',
                content: 'You are an SEO expert providing detailed, actionable recommendations. Always respond with valid JSON.'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            temperature: 0.7,
            max_tokens: 1200 // Increased for more detailed recommendations
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorMessage = errorData.error?.message || `HTTP ${response.status}`;
          
          // Handle specific error codes
          if (response.status === 429) {
            // Rate limit - fall back to rule-based
            if (attempt < maxRetries) {
              const retryAfter = response.headers.get('retry-after');
              const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
              if (onRetry) onRetry(attempt, maxRetries);
              await new Promise(resolve => setTimeout(resolve, waitTime));
              continue;
            }
            // All retries failed - return rule-based
            return ruleBasedRecs;
          } else if (response.status === 401 || response.status === 402 || response.status === 403) {
            // Auth/payment errors - fall back to rule-based silently
            return ruleBasedRecs;
          } else {
            throw new Error(`API error (${response.status}): ${errorMessage}`);
          }
        }

        const data = await response.json();
        const content = data.choices[0]?.message?.content;
        
        if (!content) {
          throw new Error('No response from AI');
        }

        // Try to parse JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const aiResponse = JSON.parse(jsonMatch[0]);
          // Record successful request
          await setLastRequestTime();
          return aiResponse;
        }
        
        // If JSON parsing fails, return rule-based
        return ruleBasedRecs;
      } catch (error) {
        lastError = error;
        // If it's not a retryable error, fall back to rule-based
        if (error.message && !error.message.includes('Rate limit') && !error.message.includes('429')) {
          return ruleBasedRecs;
        }
        // Otherwise continue to retry
      }
    }
    
    // If all retries failed, return rule-based recommendations
    return ruleBasedRecs || null;
  }

  async function renderRecommendations(report, forceGenerate = false) {
    const recommendationsContent = document.getElementById('recommendations-content');
    const recommendationsPrompt = document.getElementById('recommendations-prompt');
    const generateBtn = document.getElementById('generate-recommendations');
    const cooldownMessage = document.getElementById('cooldown-message');
    
    if (!recommendationsContent) return;

    // First check if there are any issues that need recommendations
    const issues = report.checks.filter(c => c.severity === 'fail' || c.severity === 'warn');
    if (issues.length === 0) {
      recommendationsContent.innerHTML = '';
      if (recommendationsPrompt) recommendationsPrompt.style.display = 'none';
      return; // No issues, show nothing
    }

    // No API key needed - using rule-based recommendations
    // Remove API key requirement message
    
      // Check cache first - show cached recommendations immediately
      const cached = await getCachedRecommendations(report);
      if (cached && !forceGenerate) {
        let html = '';
        for (const rec of cached.recommendations || []) {
          const issue = report.checks.find(c => c.id === rec.issue);
          if (issue && (issue.severity === 'fail' || issue.severity === 'warn')) {
            // Convert newlines to <br> tags and escape HTML to prevent issues
            const recommendationText = (rec.recommendation || '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/\n/g, '<br>');
            
            html += `
              <div class="recommendation-item ${rec.severity || issue.severity}">
                <div class="recommendation-header">${rec.title || rec.issue}</div>
                <div class="recommendation-text">${recommendationText}</div>
              </div>
            `;
          }
        }
        if (html) {
          // Hide prompt and show recommendations
          if (recommendationsPrompt) recommendationsPrompt.style.display = 'none';
          // Clear content and add recommendations
          recommendationsContent.innerHTML = html;
          const refreshBtnContainer = document.getElementById('recommendations-actions');
          if (refreshBtnContainer) refreshBtnContainer.style.display = 'block';
          return;
        }
      }
    
    // If not forcing generate, show prompt button
    if (!forceGenerate) {
      // Check if prompt exists, if not recreate it
      let promptElement = document.getElementById('recommendations-prompt');
      if (!promptElement) {
        // Recreate the prompt if it was cleared
        recommendationsContent.innerHTML = `
          <div id="recommendations-prompt" style="padding: 40px 20px; text-align: center;">
            <p id="recommendations-prompt-text" style="font-size: 14px; margin-bottom: 16px;">Click below to generate AI-powered recommendations for SEO issues found on this page.</p>
            <button id="generate-recommendations" class="settings-button">Generate Recommendations</button>
            <p id="cooldown-message" style="margin-top: 12px; font-size: 12px; display: none;"></p>
          </div>
        `;
        promptElement = document.getElementById('recommendations-prompt');
        
        // Re-attach event listener for the generate button
        const newGenerateBtn = document.getElementById('generate-recommendations');
        if (newGenerateBtn) {
          newGenerateBtn.addEventListener('click', async () => {
            const currentReport = window.currentReport;
            if (currentReport) {
              renderRecommendations(currentReport, true);
            }
          });
        }
      } else {
        // Prompt exists, just show it and remove any recommendation items
        promptElement.style.display = 'block';
        const existingRecommendations = recommendationsContent.querySelectorAll('.recommendation-item, .recommendation-loading, .recommendation-error');
        existingRecommendations.forEach(el => {
          if (!promptElement.contains(el)) {
            el.remove();
          }
        });
      }
      
      // Get references to button and message
      const generateBtnRef = document.getElementById('generate-recommendations');
      const cooldownMessageRef = document.getElementById('cooldown-message');
      
      // Check if AI is available (has API key)
      const apiKey = await getOpenAIKey();
      if (apiKey) {
        // AI available - check cooldown
        const cooldown = await canMakeRequest();
        if (!cooldown.canRequest && generateBtnRef) {
          generateBtnRef.disabled = true;
          const waitSeconds = Math.ceil(cooldown.waitTime / 1000);
          if (cooldownMessageRef) {
            cooldownMessageRef.textContent = `Please wait ${waitSeconds} seconds before generating AI-enhanced recommendations again.`;
            cooldownMessageRef.style.display = 'block';
          }
          // Update countdown
          const countdownInterval = setInterval(async () => {
            const cd = await canMakeRequest();
            if (cd.canRequest) {
              if (generateBtnRef) generateBtnRef.disabled = false;
              if (cooldownMessageRef) cooldownMessageRef.style.display = 'none';
              clearInterval(countdownInterval);
            } else {
              const waitSeconds = Math.ceil(cd.waitTime / 1000);
              if (cooldownMessageRef) {
                cooldownMessageRef.textContent = `Please wait ${waitSeconds} seconds before generating AI-enhanced recommendations again.`;
              }
            }
          }, 1000);
        } else {
          if (generateBtnRef) generateBtnRef.disabled = false;
          if (cooldownMessageRef) cooldownMessageRef.style.display = 'none';
        }
      } else {
        // No API key - rule-based only, no cooldown needed
        if (generateBtnRef) generateBtnRef.disabled = false;
        if (cooldownMessageRef) cooldownMessageRef.style.display = 'none';
      }
      return;
    }
    
    // Hide prompt and show loading
    if (recommendationsPrompt) recommendationsPrompt.style.display = 'none';
    
    const apiKey = await getOpenAIKey();
    // Use OpenAI (ChatGPT) if API key is configured, otherwise use rule-based
    recommendationsContent.innerHTML = '<div class="recommendation-loading">Generating AI recommendations with ChatGPT...</div>';

    try {
      // Try AI recommendations using OpenAI (ChatGPT), falls back to rule-based if no API key
      const recommendations = await getAIRecommendations(report, (attempt, maxRetries) => {
        if (attempt > 0 && apiKey) {
          recommendationsContent.innerHTML = `<div class="recommendation-loading">Rate limit hit. Retrying with AI... (Attempt ${attempt + 1}/${maxRetries + 1})</div>`;
        }
      });
      
      if (!recommendations || !recommendations.recommendations || recommendations.recommendations.length === 0) {
        recommendationsContent.innerHTML = '';
        if (recommendationsPrompt) recommendationsPrompt.style.display = 'block';
        return; // No recommendations, show nothing
      }

      // Cache the response (same caching mechanism for consistency)
      await saveCachedRecommendations(report, recommendations);

      let html = '';
      for (const rec of recommendations.recommendations) {
        const issue = report.checks.find(c => c.id === rec.issue);
        // Only show recommendations for issues that have warnings or failures
        if (issue && (issue.severity === 'fail' || issue.severity === 'warn')) {
          // Convert newlines to <br> tags and escape HTML to prevent issues
          const recommendationText = (rec.recommendation || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
          
          html += `
            <div class="recommendation-item ${rec.severity || issue.severity}">
              <div class="recommendation-header">${rec.title || rec.issue}</div>
              <div class="recommendation-text">${recommendationText}</div>
            </div>
          `;
        }
      }
      
      recommendationsContent.innerHTML = html || '';
      const refreshBtnContainer = document.getElementById('recommendations-actions');
      if (refreshBtnContainer) refreshBtnContainer.style.display = 'block';
    } catch (error) {
      let errorMessage = error.message;
      
      // Provide helpful error messages
      errorMessage = `An error occurred while generating recommendations: ${errorMessage}. Please try refreshing the page.`;
      
      recommendationsContent.innerHTML = `<div class="recommendation-error">${errorMessage}</div>`;
      if (recommendationsPrompt) recommendationsPrompt.style.display = 'none';
    }
  }

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      
      // Update tab buttons
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Update tab content
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
      });
      document.querySelector(`.tab-content[data-content="${tabName}"]`)?.classList.add('active');

      // If switching to recommendations, show them (but don't auto-generate)
      if (tabName === 'recommendations') {
        const currentReport = window.currentReport;
        if (currentReport) {
          renderRecommendations(currentReport, false);
        }
      } else {
        // Hide refresh button on other tabs
        const refreshBtnContainer = document.getElementById('recommendations-actions');
        if (refreshBtnContainer) {
          refreshBtnContainer.style.display = 'none';
        }
      }
      
      // If switching to settings, render settings page
      if (tabName === 'settings') {
        renderSettings();
      }
    });
  });

  async function renderSettings() {
    const apiKeyInput = document.getElementById('api-key-input');
    const apiKeyStatus = document.getElementById('api-key-status');
    
    if (apiKeyInput) {
      // Load saved API key
      const key = await getOpenAIKey();
      if (key) {
        apiKeyInput.value = key;
        if (apiKeyStatus) {
          apiKeyStatus.textContent = '✓ API key is saved';
          apiKeyStatus.className = 'api-key-status success';
        }
      } else {
        if (apiKeyStatus) {
          apiKeyStatus.textContent = '';
          apiKeyStatus.className = 'api-key-status';
        }
      }
    }
  }

  const saveApiKeyBtn = document.getElementById('save-api-key');
  const apiKeyInput = document.getElementById('api-key-input');
  const apiKeyStatus = document.getElementById('api-key-status');
  
  if (saveApiKeyBtn && apiKeyInput) {
    // Load settings on page load
    renderSettings();

    saveApiKeyBtn.addEventListener('click', async () => {
      const key = apiKeyInput.value.trim();
      if (key) {
        try {
          await saveOpenAIKey(key);
          
          if (apiKeyStatus) {
            apiKeyStatus.textContent = '✓ API key saved successfully';
            apiKeyStatus.className = 'api-key-status success';
          }
          
          saveApiKeyBtn.textContent = 'Saved!';
          setTimeout(() => {
            saveApiKeyBtn.textContent = 'Save API Key';
          }, 2000);
          
          // Reload recommendations if on that tab
          const recommendationsTab = document.querySelector('.tab[data-tab="recommendations"]');
          if (recommendationsTab?.classList.contains('active')) {
            const currentReport = window.currentReport;
            if (currentReport) {
              renderRecommendations(currentReport);
            }
          }
        } catch (error) {
          if (apiKeyStatus) {
            apiKeyStatus.textContent = '✗ Failed to save API key';
            apiKeyStatus.className = 'api-key-status error';
          }
        }
      } else {
        // Remove API key
        await saveOpenAIKey('');
        if (apiKeyStatus) {
          apiKeyStatus.textContent = 'API key removed';
          apiKeyStatus.className = 'api-key-status';
        }
      }
    });
  }

  const generateRecommendationsBtn = document.getElementById('generate-recommendations');
  if (generateRecommendationsBtn) {
    generateRecommendationsBtn.addEventListener('click', async () => {
      const currentReport = window.currentReport;
      if (currentReport) {
        renderRecommendations(currentReport, true);
      }
    });
  }

  const refreshRecommendationsBtn = document.getElementById('refresh-recommendations');
  if (refreshRecommendationsBtn) {
    refreshRecommendationsBtn.addEventListener('click', async () => {
      const currentReport = window.currentReport;
      if (currentReport) {
        // Clear cache for this report to force refresh
        const cacheKey = getCacheKey(currentReport);
        chrome.storage.local.remove([cacheKey], () => {
          renderRecommendations(currentReport, true);
        });
      }
    });
  }

  document.getElementById("scan").addEventListener("click", async () => {
    const tab = await activeTab();
    if (!tab) { render(null); return; }
    if (!isHttpUrl(tab.url||'')) { render(null); return; }
    
    // Check if tab is loading (refresh in progress)
    if (tab.status === 'loading') {
      const checksEl = document.getElementById("checks");
      if (checksEl) {
        checksEl.innerHTML = '<div style="padding: 40px 20px; text-align: center;">Page is currently loading. Please wait for the page to finish loading before scanning.</div>';
      }
      return;
    }
    
    try {
      const base = await getReportRobust(tab.id);
      render(base);
      const deep = document.getElementById('deep');
      if (deep && deep.checked) {
        const augmented = await augmentReportNetwork(base);
        render(augmented);
      }
    } catch (e) {
      console.error(e);
      // Show user-friendly error message if page navigated during scan
      if (e.message && e.message.includes('navigated')) {
        const checksEl = document.getElementById("checks");
        if (checksEl) {
          checksEl.innerHTML = '<div style="padding: 40px 20px; text-align: center;">Page refreshed during scan. Please wait for the page to fully load, then try scanning again.</div>';
        }
      } else {
        render(null);
      }
    }
  });
  
  // Theme toggle functionality
  async function loadTheme() {
    try {
      const result = await chrome.storage.local.get(['theme']);
      const theme = result.theme || 'light'; // Default to light mode
      applyTheme(theme);
    } catch (e) {
      console.error('Error loading theme:', e);
      applyTheme('light'); // Default to light mode
    }
  }

  function applyTheme(theme) {
    const body = document.body;
    const themeIcon = document.getElementById('theme-icon');
    
    if (theme === 'dark') {
      body.classList.add('dark-mode');
      if (themeIcon) themeIcon.textContent = '🌙';
    } else {
      body.classList.remove('dark-mode');
      if (themeIcon) themeIcon.textContent = '☀️';
    }
  }

  async function toggleTheme() {
    const isDark = document.body.classList.contains('dark-mode');
    const newTheme = isDark ? 'light' : 'dark';
    applyTheme(newTheme);
    try {
      await chrome.storage.local.set({ theme: newTheme });
    } catch (e) {
      console.error('Error saving theme:', e);
    }
  }

  // Initialize theme on page load
  loadTheme();

  // Add click handler for theme toggle
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', toggleTheme);
  }

  (async () => {
    const tab = await activeTab();
    if (!tab) { render(null); return; }
    if (!isHttpUrl(tab.url||'')) { render(null); return; }
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
  
  