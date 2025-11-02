// content.js

(function () {
  function getTextContent() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("script,style,noscript,template").forEach(n => n.remove());
    
    // Remove dynamically added content (focus on initial HTML only)
    // This helps match the behavior of extensions that only analyze initial page load
    clone.querySelectorAll("[data-dynamic], [data-live], [data-update], [data-loaded], [data-src], [data-lazy]").forEach(n => n.remove());
    clone.querySelectorAll(".live-update, .dynamic-content, .lazy-load, [aria-live]").forEach(n => n.remove());
    clone.querySelectorAll(".ad, .advertisement, .widget, .feed, .stream, .counter, .timer").forEach(n => n.remove());
    
    // Remove hidden elements that might be dynamically shown
    const hiddenElements = clone.querySelectorAll("[style*='display: none'], [style*='display:none'], .hidden, [aria-hidden='true']");
    hiddenElements.forEach(n => n.remove());
    
    return clone.innerText || "";
  }
  function wordCount(text) {
    const m = text.toLowerCase().match(/[a-z0-9]+/g);
    return m ? m.length : 0;
  }
  function headingHierarchyOK() {
    // Sort headings by a stable identifier for deterministic results
    // This prevents fluctuations when headings are in different document order
    const list = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].sort((a, b) => {
      const aKey = `${a.tagName}|${a.textContent || ''}|${a.id || ''}|${a.className || ''}`;
      const bKey = `${b.tagName}|${b.textContent || ''}|${b.id || ''}|${b.className || ''}`;
      return aKey.localeCompare(bKey);
    });
    let last = 0;
    for (const h of list) {
      const lvl = Number(h.tagName[1]);
      if (last && lvl > last + 1) {
        return { ok: false, offender: h, msg: `Heading jump H${last} → H${lvl}` };
      }
      last = lvl;
    }
    return { ok: true };
  }
  async function loadAnchorModel() {
    if (window.__anchorModel) return window.__anchorModel;
    const url = chrome.runtime.getURL("models/anchor_model.json");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Model load failed: ${res.status}`);
    window.__anchorModel = await res.json();
    return window.__anchorModel;
  }

  async function loadAnchorScoringModel() {
    if (window.__anchorScoringModel) return window.__anchorScoringModel;
    try {
      const url = chrome.runtime.getURL("models/anchor_text_scoring_model.json");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Model load failed: ${res.status}`);
      window.__anchorScoringModel = await res.json();
      return window.__anchorScoringModel;
    } catch (e) {
      console.warn("[SEO Scout] Anchor scoring model failed to load:", e);
      return null;
    }
  }

  function scoreAnchorTextProfile(anchorAnalysis, model) {
    if (!model || !anchorAnalysis || anchorAnalysis.analyzed === 0) {
      // Fallback to simple scoring
      let score = 100;
      const issues = [];
      
      // If no anchors were analyzed, don't flag issues that require anchors
      if (anchorAnalysis.analyzed === 0) {
        // Only flag if there are empty anchors in the total
        if (anchorAnalysis.empty > 0 && anchorAnalysis.total > 0) {
          issues.push(`No analyzable anchors found (${anchorAnalysis.empty} empty anchor(s))`);
          score = 95; // Not perfect, but not failing either
        } else if (anchorAnalysis.total === 0) {
          issues.push('No anchor links found on page');
          score = 95; // Not perfect, but not failing either
        }
        // If analyzed === 0 and no empty anchors, it means all anchors were excluded
        // This is actually fine, so return 100 with no issues
        return { score, issues, grade: score >= 95 ? 'A+' : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F' };
      }
      
      if (anchorAnalysis.empty > 0) {
        const emptyRatio = anchorAnalysis.empty / anchorAnalysis.total;
        score -= Math.min(20, emptyRatio * 40);
        issues.push(`Empty anchors: ${anchorAnalysis.empty}`);
      }
      
      const exactMatchRatio = anchorAnalysis.exactMatch / anchorAnalysis.analyzed;
      if (exactMatchRatio > 0.05) {
        score -= Math.min(30, (exactMatchRatio - 0.05) * 300);
        issues.push(`Exact-match: ${(exactMatchRatio * 100).toFixed(1)}%`);
      }
      
      const descriptiveRatio = anchorAnalysis.descriptive / anchorAnalysis.analyzed;
      if (descriptiveRatio < 0.5) {
        score -= Math.min(20, (0.5 - descriptiveRatio) * 40);
        issues.push(`Low descriptiveness: ${(descriptiveRatio * 100).toFixed(1)}%`);
      }
      
      score = Math.max(0, Math.min(100, Math.round(score)));
      
      return { score, issues, grade: score >= 95 ? 'A+' : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F' };
    }
    
    const baseline = model.baseline_metrics || {};
    const targetExactMatch = baseline.target_exact_match || 0.05;
    const targetDescriptive = baseline.target_descriptive || 0.5;
    const minInternalRatio = baseline.min_internal_ratio || 0.2;
    const maxInternalRatio = baseline.max_internal_ratio || 0.95;
    
    let score = 100;
    const issues = [];
    
    // Check empty anchors
    if (anchorAnalysis.empty > 0) {
      const emptyRatio = anchorAnalysis.total > 0 ? anchorAnalysis.empty / anchorAnalysis.total : 0;
      const penalty = Math.min(20, emptyRatio * 40);
      score -= penalty;
      issues.push(`Empty anchors: ${anchorAnalysis.empty} (${(emptyRatio * 100).toFixed(1)}%)`);
    }
    
    // Check exact-match ratio (target: ≤5%)
    const exactMatchRatio = anchorAnalysis.analyzed > 0 ? anchorAnalysis.exactMatch / anchorAnalysis.analyzed : 0;
    if (exactMatchRatio > targetExactMatch) {
      const excess = exactMatchRatio - targetExactMatch;
      const penalty = Math.min(30, excess * 300);
      score -= penalty;
      issues.push(`Exact-match too high: ${(exactMatchRatio * 100).toFixed(1)}% (target: ≤${(targetExactMatch * 100).toFixed(0)}%)`);
    }
    
    // Check descriptive ratio (target: ≥50%)
    // Only check if we have anchors analyzed
    const descriptiveRatio = anchorAnalysis.analyzed > 0 ? anchorAnalysis.descriptive / anchorAnalysis.analyzed : 0;
    if (anchorAnalysis.analyzed > 0 && descriptiveRatio < targetDescriptive) {
      const deficit = targetDescriptive - descriptiveRatio;
      const penalty = Math.min(20, deficit * 40);
      score -= penalty;
      issues.push(`Low descriptiveness: ${(descriptiveRatio * 100).toFixed(1)}% (target: ≥${(targetDescriptive * 100).toFixed(0)}%)`);
    }
    
    // Check variety (branded + generic + partial match)
    // Only check if we have anchors analyzed
    const varietyRatio = anchorAnalysis.analyzed > 0 ? (anchorAnalysis.branded + anchorAnalysis.generic + anchorAnalysis.partialMatch) / anchorAnalysis.analyzed : 0;
    if (anchorAnalysis.analyzed > 0 && varietyRatio < 0.3) {
      const penalty = Math.min(15, (0.3 - varietyRatio) * 50);
      score -= penalty;
      issues.push(`Low variety: ${(varietyRatio * 100).toFixed(1)}% (target: ≥30%)`);
    }
    
    // Check internal/external balance
    const totalLinks = anchorAnalysis.internal + anchorAnalysis.external;
    if (totalLinks > 0) {
      const internalRatio = anchorAnalysis.internal / totalLinks;
      if (internalRatio > maxInternalRatio) {
        score -= 10;
        issues.push(`Too few external links: ${(internalRatio * 100).toFixed(1)}% internal`);
      } else if (internalRatio < minInternalRatio) {
        score -= 10;
        issues.push(`Too few internal links: ${(internalRatio * 100).toFixed(1)}% internal`);
      }
    }
    
    score = Math.max(0, Math.min(100, Math.round(score)));
    
    return {
      score,
      issues,
      grade: score >= 95 ? 'A+' : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F'
    };
  }

  let anchorModel = null;
  const anchorModelReady = (async () => {
    try { anchorModel = await loadAnchorModel(); }
    catch (e) { console.warn("[SEO Scout] AI model failed to load:", e); }
  })();
  
  let anchorScoringModel = null;
  const anchorScoringModelReady = (async () => {
    try { anchorScoringModel = await loadAnchorScoringModel(); }
    catch (e) { console.warn("[SEO Scout] Anchor scoring model failed to load:", e); }
  })();

  // AI feature for anchor text classification
  function hashToken(token, nFeatures) {
    let h = 2166136261 >>> 0;
    for (let i=0;i<token.length;i++){ h ^= token.charCodeAt(i); h = Math.imul(h,16777619); }
    return Math.abs(h) % nFeatures;
  }
  function textFeats(text, nTextFeats, ngramMax=2) {
    const toks = (text.toLowerCase().match(/[a-z0-9]+/g) || []);
    const vec = new Float32Array(nTextFeats);
    for (let i=0;i<toks.length;i++){
      vec[hashToken(toks[i], nTextFeats)] += 1;
      if (ngramMax >= 2 && i){ vec[hashToken(toks[i-1]+" "+toks[i], nTextFeats)] += 1; }
    }
    let norm = 0; for (let v of vec) norm += v*v; norm = Math.sqrt(norm)||1;
    for (let i=0;i<vec.length;i++) vec[i] /= norm;
    return vec;
  }
  function numericFeats(t){
    const L = t.length;
    const words = (t.match(/[A-Za-z0-9]+/g) || []);
    const num_words = words.length;
    const pct_nonalpha = (t.replace(/[A-Za-z0-9\s]/g,"").length) / Math.max(1, L);
    const has_click_here = /\b(click|here|read more|learn more)\b/i.test(t) ? 1 : 0;
    const is_all_caps = (t === t.toUpperCase() && L >= 4) ? 1 : 0;
    const has_cta = /\b(book|contact|buy|schedule|subscribe|call|get started|start now|sign up|try|demo|download|learn more|read more|shop|order|join|request a demo|get a demo|free trial)\b/i.test(t) ? 1 : 0;
    const avg_token_len = num_words ? (words.reduce((s,w)=>s+w.length,0)/num_words) : 0;
    return [L, num_words, pct_nonalpha, has_click_here, is_all_caps, has_cta, avg_token_len];
  }
  function softmax(arr){ const m=Math.max(...arr); const ex=arr.map(v=>Math.exp(v-m)); const Z=ex.reduce((a,b)=>a+b,0); return ex.map(e=>e/Z); }
  function classifyAnchorText(text, model){
    const nText = model.n_text_features, nNum = model.num_feat_count;
    const tv = textFeats(text, nText, (model.hashing?.ngram_max||2));
    const nv = numericFeats(text);
    const feats = new Float32Array(nText + nNum);
    feats.set(tv, 0); for (let i=0;i<nNum;i++) feats[nText+i] = nv[i];

    let best=-1e9, bestIdx=-1; const scores=[];
    for (let k=0;k<model.classes.length;k++){
      const w=model.coef[k]; let s=model.intercept[k];
      for (let i=0;i<feats.length;i++) s += feats[i]*w[i];
      scores.push(s); if (s>best){ best=s; bestIdx=k; }
    }
    const probs=softmax(scores);
    return { label: model.classes[bestIdx], probs };
  }
  async function aiAnchorSummary(limit=400){
    if (!anchorModel) await anchorModelReady;
    if (!anchorModel) return null;
    const anchors = [...document.querySelectorAll("a[href]")];
    // Sort anchors by stable identifier for deterministic results
    // This prevents score fluctuations when anchors are in different document order
    anchors.sort((a, b) => {
      const aText = (a.textContent||"").trim() || (a.querySelector('img')?.getAttribute('alt')||"").trim();
      const bText = (b.textContent||"").trim() || (b.querySelector('img')?.getAttribute('alt')||"").trim();
      const aKey = `${a.getAttribute('href') || ''}|${aText}`;
      const bKey = `${b.getAttribute('href') || ''}|${bText}`;
      return aKey.localeCompare(bKey);
    });
    const counts = { good:0, weak:0, cta:0, junk:0 };
    const N = Math.min(anchors.length, limit);
    for (let i=0;i<N;i++){
      // Get anchor text: use textContent, or image alt if no text
      let t = (anchors[i].textContent||"").trim();
      if (t.length === 0) {
        const img = anchors[i].querySelector('img');
        if (img) {
          t = (img.getAttribute('alt')||"").trim();
        }
      }
      if (t.length > 0) {
      const pred = classifyAnchorText(t, anchorModel);
      counts[pred.label] = (counts[pred.label]||0)+1;
      }
    }
    return { total: anchors.length, sampled: N, ...counts };
  }
  
  // Wait for elements to appear (for dynamically loaded content)
  async function waitForElements(timeout = 200) {
    // Quick check first - if elements already exist, don't wait
    const hasTitle = document.querySelector('title')?.textContent?.trim() || document.title?.trim();
    const hasMetaDesc = document.querySelector('meta[name="description"]') || 
                       document.querySelector('meta[property="description"]') ||
                       document.querySelector('meta[property="og:description"]');
    const hasH1 = document.querySelector('h1');
    
    // If title and at least one of metaDesc or H1 exists, proceed immediately
    if (hasTitle && (hasMetaDesc || hasH1)) {
      return true; // Elements already present, proceed immediately
    }
    
    // Only wait if elements are missing, and reduce timeout
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const hasTitleNow = document.querySelector('title')?.textContent?.trim() || document.title?.trim();
      const hasMetaDescNow = document.querySelector('meta[name="description"]') || 
                           document.querySelector('meta[property="description"]') ||
                           document.querySelector('meta[property="og:description"]');
      const hasH1Now = document.querySelector('h1');
      
      // Proceed if we have title and at least one other element
      if (hasTitleNow && (hasMetaDescNow || hasH1Now)) return true;
      await new Promise(resolve => setTimeout(resolve, 25)); // Check more frequently
    }
    return false; // Timeout reached, proceed anyway
  }
  
  async function analyze() {
    // Capture the initial URL to detect navigation during analysis
    let initialUrl;
    try {
      initialUrl = (window.top !== window ? window.top.location.href : location.href).split("#")[0];
    } catch (e) {
      initialUrl = location.href.split("#")[0];
    }
    
    // Quick check: If page is actively loading/unloading (refresh in progress), abort
    if (document.readyState === 'loading') {
      throw new Error('Page is currently loading - please wait for page to finish loading before scanning');
    }
    
    // For pages that might load content dynamically, wait a bit for key elements
    // This helps catch content loaded via JavaScript after initial page load
    // Reduced timeout for faster analysis - only wait if elements are actually missing
    await waitForElements(200);
    
    // Get current URL - check if it changed (navigation happened)
    let url;
    try {
      url = (window.top !== window ? window.top.location.href : location.href).split("#")[0];
    } catch (e) {
      url = location.href.split("#")[0];
    }
    
    // If URL changed significantly, the page refreshed - return early to avoid bad data
    if (url !== initialUrl) {
      const initialBase = initialUrl.split('#')[0].split('?')[0];
      const currentBase = url.split('#')[0].split('?')[0];
      if (initialBase !== currentBase) {
        throw new Error('Page navigated during analysis - please wait for page to fully load before scanning');
      }
    }
    
    // Take a snapshot of key DOM elements at scan time to prevent fluctuations
    // This ensures we analyze the same content even if DOM changes between scans
    const snapshot = {
      title: '',
      metaDesc: '',
      robots: '',
      canonical: '',
      viewport: '',
      lang: '',
      h1s: [],
      images: [],
      anchors: [],
      ogTags: [],
      twitterTags: []
    };
    
    // Capture all metadata first (most stable)
    // Check multiple sources for title to ensure we capture it
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
      
      // Also check document.title as fallback (often more reliable for dynamic content)
      if (!titleValue) {
        const docTitle = (document.title || '').trim();
        if (docTitle && !isAdOrIframeTitle(docTitle)) {
          titleValue = docTitle;
        }
      }
      
      // Try to get from head element directly
      if (!titleValue && document.head) {
        const headTitle = document.head.querySelector('title');
        if (headTitle) {
          const headTitleText = (headTitle.textContent || headTitle.innerText || '').trim();
          if (headTitleText && !isAdOrIframeTitle(headTitleText)) {
            titleValue = headTitleText;
          }
        }
      }
    }
    snapshot.title = titleValue;
    
    // Check multiple ways to get meta description (some sites use different attributes)
    let metaDescValue = '';
    // Try standard name="description" first
    let metaDescEl = document.querySelector('meta[name="description"]');
    if (metaDescEl) {
      metaDescValue = metaDescEl.getAttribute('content')?.trim() || '';
    }
    // Also check property="description" (some sites use this)
    if (!metaDescValue) {
      metaDescEl = document.querySelector('meta[property="description"]');
      if (metaDescEl) {
        metaDescValue = metaDescEl.getAttribute('content')?.trim() || '';
      }
    }
    // Check Open Graph description as fallback (some sites only use OG)
    if (!metaDescValue) {
      metaDescEl = document.querySelector('meta[property="og:description"]');
      if (metaDescEl) {
        metaDescValue = metaDescEl.getAttribute('content')?.trim() || '';
      }
    }
    // Also check in head element directly if not found
    if (!metaDescValue && document.head) {
      const headMetaDesc = document.head.querySelector('meta[name="description"]');
      if (headMetaDesc) {
        metaDescValue = headMetaDesc.getAttribute('content')?.trim() || '';
      }
      // Also try all meta tags in head and check for description-like content
      if (!metaDescValue) {
        const allMetas = document.head.querySelectorAll('meta');
        for (const meta of allMetas) {
          if (meta.getAttribute('name') === 'description' || meta.getAttribute('property') === 'description') {
            metaDescValue = meta.getAttribute('content')?.trim() || '';
            if (metaDescValue) break;
          }
        }
      }
    }
    snapshot.metaDesc = metaDescValue;
    
    const robotsEl = document.querySelector('meta[name="robots"]');
    snapshot.robots = (robotsEl?.content?.toLowerCase() || '').trim();
    
    const canonicalEl = document.querySelector('link[rel="canonical"]');
    snapshot.canonical = canonicalEl?.href || '';
    
    const viewportEl = document.querySelector('meta[name="viewport"]');
    snapshot.viewport = viewportEl?.content || '';
    
    snapshot.lang = document.documentElement.getAttribute("lang") || '';
    
    // Capture and sort H1s immediately - be less aggressive with filtering
    // Only exclude H1s that are clearly in ads/widgets, but keep main content H1s
    // Quick H1 collection - no retry delay for faster analysis
    const h1Elements = [...document.querySelectorAll("h1")];
    snapshot.h1s = h1Elements
      .filter(h => {
        // Skip only obviously dynamic/ad content - be more permissive for main content
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
      .map(h => ({
        text: (h.textContent || '').trim(),
        id: h.id || '',
        className: h.className || '',
        // Store position info to identify main content H1s
        isMainContent: h.closest('main, article, [role="main"], section[role="main"]') !== null
      }))
      .sort((a, b) => {
        // Prioritize main content H1s first, then sort by content
        if (a.isMainContent !== b.isMainContent) return b.isMainContent - a.isMainContent;
        const aKey = `${a.text}|${a.id}|${a.className}`;
        const bKey = `${b.text}|${b.id}|${b.className}`;
        return aKey.localeCompare(bKey);
      });
    
    // Capture and sort images immediately - focus on static content from initial HTML
    // Exclude dynamically loaded images (lazy-loaded, ads, widgets, etc.)
    snapshot.images = [...Array.from(document.images)]
      .filter(img => {
        // Skip very small images (icons/sprites) and data URIs (often dynamic)
        if (img.naturalWidth < 20 && img.naturalHeight < 20) return false;
        if (img.src && img.src.startsWith('data:')) return false;
        
        // Exclude images in dynamic containers
        let parent = img.parentElement;
        let depth = 0;
        while (parent && parent !== document.body && depth < 10) {
          const parentClass = parent.className || '';
          const parentId = parent.id || '';
          const isDynamic = /(ad|advertisement|widget|live-update|dynamic|counter|timer|feed|stream|lazy|loading|modal|popup|tooltip|banner)/i.test(parentClass + parentId) ||
                           parent.hasAttribute('data-dynamic') ||
                           parent.hasAttribute('data-live') ||
                           parent.hasAttribute('aria-live') ||
                           parent.hasAttribute('data-loaded') ||
                           img.hasAttribute('data-src') || // Lazy-loaded images
                           img.hasAttribute('data-lazy');
          if (isDynamic) return false;
          parent = parent.parentElement;
          depth++;
        }
        
        // Exclude social media embeds, tracking pixels, etc.
        if (img.src && /(tracking|pixel|beacon|analytics|facebook|twitter|linkedin|instagram)/i.test(img.src)) return false;
        
        return true;
      })
      .map(img => ({
        src: img.src || '',
        alt: img.getAttribute('alt') || '',
        id: img.id || '',
        hasAlt: img.hasAttribute("alt") && img.getAttribute("alt").trim() !== ""
      }))
      .sort((a, b) => {
        const aKey = `${a.src}|${a.alt}|${a.id}`;
        const bKey = `${b.src}|${b.alt}|${b.id}`;
        return aKey.localeCompare(bKey);
      });
    
    // Capture and sort anchors immediately - focus on static navigation/content links
    // Exclude dynamically added anchors (ads, widgets, social feeds, etc.)
    snapshot.anchors = [...document.querySelectorAll("a[href]")]
      .filter(a => {
        // Exclude anchors in dynamic containers
        let parent = a.parentElement;
        let depth = 0;
        while (parent && parent !== document.body && depth < 10) {
          const parentClass = parent.className || '';
          const parentId = parent.id || '';
          const isDynamic = /(ad|advertisement|widget|live-update|dynamic|counter|timer|feed|stream|modal|popup|tooltip|sidebar|panel|content-slot|lazy-load|social|share-button)/i.test(parentClass + parentId) ||
                           parent.hasAttribute('data-dynamic') ||
                           parent.hasAttribute('data-live') ||
                           parent.hasAttribute('aria-live') ||
                           parent.hasAttribute('data-loaded');
          if (isDynamic) return false;
          parent = parent.parentElement;
          depth++;
        }
        return true;
      })
      .map(a => {
        const text = (a.textContent || "").trim();
        const href = a.getAttribute('href') || '';
        const img = a.querySelector('img');
        const imgAlt = img ? (img.getAttribute('alt') || "").trim() : '';
        return {
          text: text || imgAlt || '',
          href: href,
          hasImg: !!img,
          hasAudio: !!a.querySelector('audio'),
          hasVideo: !!a.querySelector('video'),
          className: a.className || ''
        };
      })
      .sort((a, b) => {
        const aKey = `${a.href}|${a.text}`;
        const bKey = `${b.href}|${b.text}`;
        return aKey.localeCompare(bKey);
      });
    
    // Capture meta tags
    snapshot.ogTags = [...document.querySelectorAll('meta[property^="og:"]')]
      .map(m => ({
        property: m.getAttribute('property') || '',
        content: m.getAttribute('content') || ''
      }))
      .sort((a, b) => {
        const aKey = `${a.property}|${a.content}`;
        const bKey = `${b.property}|${b.content}`;
        return aKey.localeCompare(bKey);
      });
    
    snapshot.twitterTags = [...document.querySelectorAll('meta[name^="twitter:"]')]
      .map(m => ({
        name: m.getAttribute('name') || '',
        content: m.getAttribute('content') || ''
      }))
      .sort((a, b) => {
        const aKey = `${a.name}|${a.content}`;
        const bKey = `${b.name}|${b.content}`;
        return aKey.localeCompare(bKey);
      });
    
    // Use snapshot data instead of querying DOM again (prevents fluctuations)
    const title = snapshot.title;
    const metaDesc = snapshot.metaDesc;
    const robots = snapshot.robots;
    const canonical = snapshot.canonical;
    const viewport = snapshot.viewport;
    const lang = snapshot.lang;

    // Reconstruct H1 elements from snapshot using actual DOM elements
    const allDomH1s = [...document.querySelectorAll("h1")];
    const h1sMap = new Map();
    allDomH1s.forEach(h => {
      const key = `${(h.textContent || '').trim()}|${h.id || ''}|${h.className || ''}`;
      if (!h1sMap.has(key)) {
        h1sMap.set(key, h);
      }
    });
    
    // Build h1s array from snapshot order using actual DOM elements
    const h1s = snapshot.h1s.map(h => {
      const key = `${h.text}|${h.id}|${h.className}`;
      return h1sMap.get(key) || allDomH1s.find(el => 
        (el.textContent || '').trim() === h.text &&
        (el.id || '') === h.id &&
        (el.className || '') === h.className
      );
    }).filter(Boolean); // Remove any null/undefined entries
    
    const hh = headingHierarchyOK();

    // Use snapshot for text content - getTextContent may change, so capture it once
    const textContentSnapshot = getTextContent();
    const words = wordCount(textContentSnapshot);

    // Reconstruct image elements from snapshot using actual DOM elements
    const allDomImages = [...Array.from(document.images)];
    const imgsMap = new Map();
    allDomImages.forEach(img => {
      const key = `${img.src || ''}|${img.getAttribute('alt') || ''}|${img.id || ''}`;
      if (!imgsMap.has(key)) {
        imgsMap.set(key, img);
      }
    });
    
    // Build imgs array from snapshot order using actual DOM elements
    const imgs = snapshot.images.map(img => {
      const key = `${img.src}|${img.alt}|${img.id}`;
      return imgsMap.get(key) || allDomImages.find(el => 
        el.src === img.src &&
        (el.getAttribute('alt') || '') === img.alt &&
        (el.id || '') === img.id
      );
    }).filter(Boolean); // Remove any null/undefined entries
    
    const imgsMissingAlt = imgs.filter(i => !i.hasAttribute("alt") || i.getAttribute("alt").trim() === "");

    // Reconstruct anchors from snapshot using actual DOM elements
    // Map all anchors to find matching DOM elements
    const allDomAnchors = [...document.querySelectorAll("a[href]")];
    const anchorsMap = new Map();
    allDomAnchors.forEach(a => {
      const text = (a.textContent || "").trim();
      const href = a.getAttribute('href') || '';
      const img = a.querySelector('img');
      const imgAlt = img ? (img.getAttribute('alt') || "").trim() : '';
      const key = `${href}|${text || imgAlt || ''}`;
      // Keep first match for each key to avoid duplicates
      if (!anchorsMap.has(key)) {
        anchorsMap.set(key, a);
      }
    });
    
    // Build anchors array from snapshot order using actual DOM elements
    const anchors = snapshot.anchors.map(a => {
      const key = `${a.href}|${a.text}`;
      return anchorsMap.get(key) || allDomAnchors.find(el => {
        const elText = (el.textContent || "").trim();
        const elHref = el.getAttribute('href') || '';
        const elImg = el.querySelector('img');
        const elImgAlt = elImg ? (elImg.getAttribute('alt') || "").trim() : '';
        return elHref === a.href && (elText || elImgAlt) === a.text;
      });
    }).filter(Boolean); // Remove any null/undefined entries
    // Analyze anchor text using best practices rubric:
    // 1. Natural and varied links (branded, generic, partial match)
    // 2. Descriptive text (relevant to destination)
    // 3. Avoid overuse of exact-match anchors (5% or less)
    // 4. Balance internal and external linking
    
    const currentUrl = url || location.href;
    let currentOrigin = '';
    try {
      currentOrigin = new URL(currentUrl).origin;
    } catch (e) {}
    
    // Extract domain for branded anchor detection
    let currentDomain = '';
    try {
      currentDomain = new URL(currentUrl).hostname.replace(/^www\./, '');
      // Extract brand name from domain (e.g., "destinytracker" from "destinytracker.com")
      currentDomain = currentDomain.split('.')[0];
    } catch (e) {}
    
    // Helper to get anchor text for analysis (text content or image alt text)
    function getAnchorText(anchor) {
      const text = (anchor.textContent || "").trim();
      if (text.length > 0) return text;
      // If no text but has image with alt, use alt text
      const img = anchor.querySelector('img');
      if (img) {
        const alt = (img.getAttribute('alt') || "").trim();
        if (alt.length > 0) return alt;
      }
      return "";
    }
    
    // Helper to check if anchor should be excluded from AI classification
    function shouldExcludeFromAI(anchor) {
      const t = getAnchorText(anchor);
      if (t.length === 0) return true;
      
      // Exclude anchors that contain media elements (images, audio, video)
      // Media elements in links serve accessibility/visual/navigation purposes,
      // not SEO anchor text analysis
      const hasImg = anchor.querySelector('img') !== null;
      const hasAudio = anchor.querySelector('audio') !== null;
      const hasVideo = anchor.querySelector('video') !== null;
      if (hasImg || hasAudio || hasVideo) return true;
      
      // Exclude anchors with avatar/image-related classes
      const className = anchor.className || '';
      const avatarClasses = /(avatar|main-avatar|user-avatar|profile-picture|profile-image|user-image)/i;
      if (avatarClasses.test(className)) return true;
      
      // Exclude logo/brand links (common in headers)
      const logoBrandClasses = /(logo|brand|site-logo|brand-logo|company-logo|header-logo)/i;
      if (logoBrandClasses.test(className)) return true;
      
      // Check parent containers for media elements and navigation context
      let parent = anchor.parentElement;
      const navContexts = ['nav', 'header', '.navigation', '.nav', '.breadcrumb', '.breadcrumbs', '.menu'];
      while (parent && parent !== document.body) {
        // Check for media elements in parent
        if (parent.querySelector('img') || parent.querySelector('audio') || parent.querySelector('video')) {
          return true;
        }
        
        // Check if in navigation context
        const parentTag = parent.tagName?.toLowerCase() || '';
        const parentClass = parent.className || '';
        const parentRole = parent.getAttribute?.('role') || '';
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
        parent = parent.parentElement;
      }
      
      // Exclude common navigation links (even outside nav elements)
      const commonNavLinks = /^(home|faq|about|contact|blog|news|products|services|support|help|login|sign|search|menu)$/i;
      if (commonNavLinks.test(t)) {
        // Only exclude if it's a common link (not if it's part of a longer descriptive phrase)
        return t.length <= 20;
      }
      
      // Exclude anchors with media player control classes (e.g., "mw-tmh-play", "media-player", etc.)
      const mediaControlClasses = /(mw-tmh|media-player|audio-player|video-player|play-button|media-control)/i;
      if (mediaControlClasses.test(className)) return true;
      
      // Exclude links to media files (.mp3, .mp4, .wav, .ogg, etc.)
      const href = anchor.getAttribute('href') || '';
      const mediaExts = /\.(mp3|mp4|wav|ogg|webm|avi|mov|wmv|flv|m4a|aac|wma|pdf|zip|rar|exe|dmg)$/i;
      if (mediaExts.test(href)) return true;
      
      // Exclude anchors with "Play audio/video" type titles
      const title = anchor.getAttribute('title') || '';
      if (/\b(play|audio|video|sound|media)\b/i.test(title) && t.length <= 20) return true;
      
      // Exclude anchors that are purely numeric (e.g., "1", "2024", "42")
      // These are often legitimate (page numbers, years, etc.)
      if (/^\d+$/.test(t)) return true;
      
      // Exclude very short anchors (1-2 chars) that are likely non-English
      // or are just symbols/punctuation (but allow short English words like "Go", "OK")
      if (t.length <= 2) {
        // If it's just digits or symbols, exclude
        if (/^[\d\s\W]+$/.test(t)) return true;
        // If it's a single non-ASCII character, likely another language
        if (t.length === 1 && /[^\x00-\x7F]/.test(t)) return true;
      }
      
      return false;
    }
    
    // Analyze anchors using best practices rubric
    // Sort anchors for deterministic results
    const sortedAnchors = [...anchors].sort((a, b) => {
      const aKey = `${a.getAttribute('href') || ''}|${getAnchorText(a)}`;
      const bKey = `${b.getAttribute('href') || ''}|${getAnchorText(b)}`;
      return aKey.localeCompare(bKey);
    });
    
    // Analyze anchors for best practices
    const anchorAnalysis = {
      total: sortedAnchors.length,
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
    
    // Track problematic anchors for highlighting
    const problematicAnchors = {
      empty: [],
      exactMatch: [],
      nonDescriptive: []
    };
    
    // Analyze up to 200 anchors (sampling for performance)
    const sampleSize = Math.min(sortedAnchors.length, 200);
    
    for (let i = 0; i < sampleSize; i++) {
      const anchor = sortedAnchors[i];
      const text = getAnchorText(anchor);
      const href = anchor.getAttribute('href') || '';
      
      // Skip excluded anchors (media, navigation, etc.)
      if (shouldExcludeFromReport(anchor) || shouldExcludeFromAI(anchor)) continue;
      
      anchorAnalysis.analyzed++;
      
      // Check if empty
      if (text.length === 0) {
        anchorAnalysis.empty++;
        problematicAnchors.empty.push(anchor);
        continue;
      }
      
      // Classify anchor text type
      const lowerText = text.toLowerCase().trim();
      const textWords = lowerText.split(/\s+/).filter(w => w.length > 0);
      
      // Detect branded anchors (contains domain/brand name)
      let isBranded = false;
      if (currentDomain) {
        const domainLower = currentDomain.toLowerCase();
        if (lowerText.includes(domainLower) || 
            lowerText.includes(domainLower.replace(/\s+/g, ''))) {
          isBranded = true;
          anchorAnalysis.branded++;
        }
      }
      
      // Detect generic anchors (click here, read more, learn more, etc.)
      const genericPatterns = /\b(click here|read more|learn more|see more|view more|here|this|link|page|website|site|url)\b/i;
      const isGeneric = genericPatterns.test(text);
      if (isGeneric && !isBranded) {
        anchorAnalysis.generic++;
        // Generic anchors are not considered descriptive
        continue;
      }
      
      // Detect exact-match anchors (anchor text matches page keywords exactly)
      // Simplified: flag very keyword-dense anchor text as potential exact-match
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
        problematicAnchors.exactMatch.push(anchor);
      } else if (!isBranded && !isGeneric && text.length > 5) {
        // Partial match or descriptive
        anchorAnalysis.partialMatch++;
      }
      
      // Check if descriptive (has meaningful content, not just generic terms)
      const isDescriptive = text.length >= 10 && 
                           textWords.length >= 2 && 
                           !isGeneric;
      if (isDescriptive) {
        anchorAnalysis.descriptive++;
      } else if (!isGeneric && text.length > 0) {
        // Non-descriptive anchor (not generic but also not descriptive enough)
        problematicAnchors.nonDescriptive.push(anchor);
      }
      
      // Classify as internal or external
      if (href) {
        try {
          const hrefUrl = new URL(href, currentUrl);
          if (hrefUrl.origin === currentOrigin) {
            anchorAnalysis.internal++;
          } else {
            anchorAnalysis.external++;
          }
        } catch (e) {
          // Relative or invalid URL - assume internal
          if (href.startsWith('#') || href.startsWith('/') || !href.startsWith('http')) {
            anchorAnalysis.internal++;
          } else {
            anchorAnalysis.external++;
          }
        }
      }
    }
    
    // Calculate metrics
    const analyzedRatio = anchorAnalysis.analyzed > 0 ? anchorAnalysis.analyzed / anchorAnalysis.total : 0;
    const exactMatchRatio = anchorAnalysis.analyzed > 0 ? anchorAnalysis.exactMatch / anchorAnalysis.analyzed : 0;
    const descriptiveRatio = anchorAnalysis.analyzed > 0 ? anchorAnalysis.descriptive / anchorAnalysis.analyzed : 0;
    const emptyRatio = anchorAnalysis.analyzed > 0 ? anchorAnalysis.empty / anchorAnalysis.analyzed : 0;
    const varietyScore = anchorAnalysis.analyzed > 0 ? 
      (anchorAnalysis.branded + anchorAnalysis.generic + anchorAnalysis.partialMatch) / anchorAnalysis.analyzed : 0;
    
    // Score anchor text using trained model based on SEO-optimized websites
    // Don't wait for model - use whatever is available (model loads in background)
    const scoringResult = scoreAnchorTextProfile(anchorAnalysis, anchorScoringModel);
    const anchorScore = scoringResult.score;
    const anchorGrade = scoringResult.grade;
    
    // Use model's issues if available, otherwise determine issues from rubric
    if (scoringResult.issues && scoringResult.issues.length > 0) {
      anchorAnalysis.issues = scoringResult.issues;
    } else if (anchorAnalysis.analyzed === 0) {
      // If no anchors analyzed, use scoring result's issues (which should be empty or minimal)
      // Don't add fallback issues that require analyzed anchors
      anchorAnalysis.issues = scoringResult.issues || [];
    } else {
      // Determine issues based on rubric if model didn't provide any AND we have analyzed anchors
      if (anchorAnalysis.empty > 0) {
        anchorAnalysis.issues.push(`${anchorAnalysis.empty} empty anchor(s)`);
      }
      if (exactMatchRatio > 0.05) {
        anchorAnalysis.issues.push(`${(exactMatchRatio * 100).toFixed(1)}% exact-match (target: ≤5%)`);
      }
      if (descriptiveRatio < 0.5) {
        anchorAnalysis.issues.push(`Only ${(descriptiveRatio * 100).toFixed(1)}% descriptive (target: ≥50%)`);
      }
      const totalLinks = anchorAnalysis.internal + anchorAnalysis.external;
      const internalRatio = totalLinks > 0 ? anchorAnalysis.internal / totalLinks : 0;
      const hasBalance = totalLinks === 0 || (internalRatio > 0.2 && internalRatio < 0.95);
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
    }
    
    const hasIssues = anchorAnalysis.issues.length > 0;
    const anchorStatus = hasIssues ? 'warn' : 'pass';
    
    // Enhanced message with score and grade from trained model
    const anchorMessage = hasIssues 
      ? `Anchor text score: ${anchorScore}/100 (${anchorGrade}). Issues: ${anchorAnalysis.issues.join('; ')}. Analysis: ${anchorAnalysis.branded} branded, ${anchorAnalysis.generic} generic, ${anchorAnalysis.partialMatch} partial match, ${anchorAnalysis.exactMatch} exact-match (${(exactMatchRatio * 100).toFixed(1)}%). Internal: ${anchorAnalysis.internal}, External: ${anchorAnalysis.external}.`
      : `Anchor text score: ${anchorScore}/100 (${anchorGrade}). Follows best practices. ${anchorAnalysis.branded} branded, ${anchorAnalysis.generic} generic, ${anchorAnalysis.partialMatch} partial match, ${anchorAnalysis.exactMatch} exact-match (${(exactMatchRatio * 100).toFixed(1)}%). Internal: ${anchorAnalysis.internal}, External: ${anchorAnalysis.external}.`;
    
    // Collect all problematic anchors for highlighting based on issues found
    const anchorsToHighlight = [];
    
    // Always highlight empty anchors if they exist
    if (anchorAnalysis.empty > 0) {
      anchorsToHighlight.push(...problematicAnchors.empty);
    }
    
    // Highlight exact-match anchors if ratio is too high (>5%)
    if (exactMatchRatio > 0.05) {
      anchorsToHighlight.push(...problematicAnchors.exactMatch);
    }
    
    // Highlight non-descriptive anchors if ratio is too low (<50%)
    // But exclude exact-match anchors to avoid double highlighting
    if (descriptiveRatio < 0.5 && anchorAnalysis.analyzed > 0) {
      const exactMatchSet = new Set(problematicAnchors.exactMatch);
      const nonDescriptiveToHighlight = problematicAnchors.nonDescriptive.filter(a => !exactMatchSet.has(a));
      anchorsToHighlight.push(...nonDescriptiveToHighlight);
    }
    
    // Remove duplicates (same anchor element might be flagged for multiple reasons)
    const uniqueAnchorsToHighlight = Array.from(new Set(anchorsToHighlight));

    // Use snapshot meta tags data (already sorted and captured)
    const ogCount = snapshot.ogTags.length;
    const twCount = snapshot.twitterTags.length;
    
    // Check for all core OpenGraph tags (og:title, og:description, og:image, og:url)
    const ogTitle = snapshot.ogTags.find(t => t.property === 'og:title')?.content?.trim() || '';
    const ogUrl = snapshot.ogTags.find(t => t.property === 'og:url')?.content?.trim() || '';
    const ogDescription = snapshot.ogTags.find(t => t.property === 'og:description')?.content?.trim() || '';
    const ogImage = snapshot.ogTags.find(t => t.property === 'og:image')?.content?.trim() || '';
    
    // Check which core OG tags are present
    const hasOGTitle = !!ogTitle;
    const hasOGUrl = !!ogUrl;
    const hasOGDescription = !!ogDescription;
    const hasOGImage = !!ogImage;
    
    // All four core tags should be present for optimal social sharing
    const allCoreOGTags = hasOGTitle && hasOGUrl && hasOGDescription && hasOGImage;

    const checks = [];
    const add = (id, ok, severity, message, where = []) =>
      checks.push({ id, ok, severity, message, where });

    add("title-length", title.length >= 45 && title.length <= 70,
      title ? (title.length >= 45 && title.length <= 70 ? "pass" : "warn") : "fail",
      `Title length: ${title.length || 0} (recommended 45–70)${title ? ` | Title: "${title}"` : ''}.`);
    add("meta-description", metaDesc.length >= 120 && metaDesc.length <= 160,
      metaDesc ? (metaDesc.length >= 120 && metaDesc.length <= 160 ? "pass" : "warn") : "fail",
      `Meta description length: ${metaDesc.length || 0} (recommended 120–160)${metaDesc ? ` | Description: "${metaDesc}"` : ''}.`);
    add("h1-count", h1s.length === 1,
      h1s.length === 0 ? "fail" : (h1s.length === 1 ? "pass" : "warn"),
      `H1 count: ${h1s.length}.`, h1s);
    add("heading-hierarchy", hh.ok, hh.ok ? "pass" : "warn",
      hh.ok ? "Heading levels are sequential." : hh.msg, hh.ok ? [] : [hh.offender]);
    add("canonical", !!canonical, canonical ? "pass" : "warn",
      canonical ? `Canonical present: ${canonical}` : "No canonical tag found.");
    const noindex = robots.includes("noindex");
    const nofollow = robots.includes("nofollow");
    // Separate checks for noindex and nofollow - each fails if present
    add("noindex", !noindex, noindex ? "fail" : "pass",
      noindex ? "Meta robots contains noindex (page won't be indexed)." : "No noindex in meta robots.");
    add("nofollow", !nofollow, nofollow ? "fail" : "pass",
      nofollow ? "Meta robots contains nofollow (links won't be followed)." : "No nofollow in meta robots.");
    add("viewport", !!viewport, viewport ? "pass" : "warn",
      viewport ? "Viewport meta present." : "No viewport meta (mobile).");
    add("lang", !!lang, lang ? "pass" : "warn",
      lang ? `html[lang="${lang}"] present.` : "Missing html[lang] attribute.");
    add("image-alt", imgsMissingAlt.length === 0, imgsMissingAlt.length === 0 ? "pass" : "warn",
      `Images missing alt: ${imgsMissingAlt.length}/${imgs.length}.`, imgsMissingAlt);
    // Filter problematic anchors to exclude media anchors and other special cases
    function shouldExcludeFromReport(anchor) {
      // Exclude anchors with media elements (images, audio, video)
      const hasImg = anchor.querySelector('img') !== null;
      const hasAudio = anchor.querySelector('audio') !== null;
      const hasVideo = anchor.querySelector('video') !== null;
      if (hasImg || hasAudio || hasVideo) return true;
      
      // Exclude anchors that are in containers with media elements
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
          if (commonNavLinks.test(getAnchorText(anchor))) return true;
          // Also exclude logo links in header/nav
          if (hasImg || logoBrandClasses.test(className)) return true;
        }
        parentNav = parentNav.parentElement;
      }
      
      // Exclude common navigation links (even outside nav elements)
      const commonNavLinks = /^(home|faq|about|contact|blog|news|products|services|support|help|login|sign|search|menu)$/i;
      const t = getAnchorText(anchor);
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
      if (/^\d+$/.test(t)) return true; // Exclude numeric anchors
      
      if (t.length <= 2) {
        if (/^[\d\s\W]+$/.test(t)) return true;
        if (t.length === 1 && /[^\x00-\x7F]/.test(t)) return true;
      }
      return false;
    }
    
    // Use the new anchor text best practices analysis
      add("anchor-text",
      !hasIssues,
      anchorStatus,
      anchorMessage,
      uniqueAnchorsToHighlight // Highlight all problematic anchors (empty, exact-match, non-descriptive)
    );
    // Check OpenGraph tags - require all 4 core tags (og:title, og:description, og:image, og:url) for pass
    // This check is weighted heavily - all 4 core tags must be present
    const ogStatus = allCoreOGTags ? 'pass' : (ogCount > 0 ? 'warn' : 'warn');
    const ogMessage = allCoreOGTags 
      ? `Open Graph tags: ${ogCount}` 
      : (ogCount > 0 ? `Open Graph tags: ${ogCount} (missing core tags)` : 'No Open Graph tags.');
    
    add("open-graph", allCoreOGTags, ogStatus, ogMessage);
    add("twitter-card", twCount > 0, twCount ? "pass" : "warn",
      twCount ? `Twitter Card tags: ${twCount}` : "No Twitter Card tags.");

    // Calculate SEO grade
    function calculateGrade(checks) {
      if (checks.length === 0) return { grade: "N/A", score: 0, percentage: 0 };
      
      let passCount = 0;
      let warnCount = 0;
      let failCount = 0;
      
      for (const check of checks) {
        if (check.severity === "pass") passCount++;
        else if (check.severity === "warn") warnCount++;
        else if (check.severity === "fail") failCount++;
      }
      
      // Weighted scoring: pass=1, warn=0.5, fail=0
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
      url,
      timestamp: Date.now(),
      summary: { title, metaDesc, canonical, robots, viewport, lang, words },
      checks,
      grade
    };
  }

  // Expose analyze function via message listener
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "GET_SEO_REPORT") {
      analyze().then(result => {
        sendResponse({ report: result });
      }).catch(err => {
        sendResponse({ error: err.message });
      });
      return true; // Keep channel open for async response
    }
    if (request.type === "GET_SEO_REPORT_AI") {
      (async () => {
        try {
          const report = await analyze();
          await anchorModelReady;
          if (anchorModel) {
            const aiSummary = await aiAnchorSummary(400);
            sendResponse({ report, aiSummary });
          } else {
            sendResponse({ report });
          }
        } catch (err) {
          sendResponse({ error: err.message });
        }
      })();
      return true; // Keep channel open for async response
    }
    if (request.type === "PING") {
      sendResponse({ pong: true });
      return false;
    }
  });
})();