// Recommendation Model Loader and Inference
// Add this to your extension to use the trained local model

async function loadRecommendationModel() {
  if (window.__recommendationModel) return window.__recommendationModel;
  try {
    const url = chrome.runtime.getURL("models/recommendation_model.json");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Model load failed: ${res.status}`);
    window.__recommendationModel = await res.json();
    return window.__recommendationModel;
  } catch (e) {
    console.warn("[SEO Scout] Recommendation model failed to load:", e);
    return null;
  }
}

function textToTFIDFVector(text, vocabulary, idf) {
  // Simple TF-IDF vectorization in JavaScript
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  const vector = new Float32Array(Object.keys(vocabulary).length);
  
  // Count term frequencies
  const tf = {};
  tokens.forEach(token => {
    // Check for token and bigrams
    if (vocabulary.hasOwnProperty(token)) {
      const idx = vocabulary[token];
      tf[idx] = (tf[idx] || 0) + 1;
    }
    // Check for bigrams (simple approach: consecutive tokens)
    for (let i = 0; i < tokens.length - 1; i++) {
      const bigram = `${tokens[i]} ${tokens[i + 1]}`;
      if (vocabulary.hasOwnProperty(bigram)) {
        const idx = vocabulary[bigram];
        tf[idx] = (tf[idx] || 0) + 1;
      }
    }
  });
  
  // Apply TF-IDF weighting
  Object.keys(tf).forEach(idx => {
    const termIdx = parseInt(idx);
    if (idf && idf[termIdx] !== undefined) {
      vector[termIdx] = tf[idx] * idf[termIdx];
    }
  });
  
  // Normalize (L2 norm)
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= norm;
    }
  }
  
  return vector;
}

function cosineSimilarity(vec1, vec2) {
  let dot = 0;
  let norm1 = 0;
  let norm2 = 0;
  
  for (let i = 0; i < vec1.length && i < vec2.length; i++) {
    dot += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }
  
  const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
  return denominator > 0 ? dot / denominator : 0;
}

async function getLocalAIRecommendation(issueId, issueMessage, severity, context = {}) {
  const model = await loadRecommendationModel();
  
  if (!model) {
    console.warn("[SEO Scout] Recommendation model not available");
    return null;
  }
  
  // Create issue text (same format as training)
  const contextStr = JSON.stringify(context, Object.keys(context).sort());
  const issueText = `${issueId} ${issueMessage} ${contextStr}`;
  
  // Convert to vector
  const issueVector = textToTFIDFVector(issueText, model.vocabulary, model.idf);
  
  // Find best match
  let bestMatchIdx = -1;
  let bestSimilarity = -1;
  const SIMILARITY_THRESHOLD = 0.3; // Minimum similarity to return a match
  
  for (let i = 0; i < model.embeddings.length; i++) {
    const trainingVector = new Float32Array(model.embeddings[i]);
    const similarity = cosineSimilarity(issueVector, trainingVector);
    
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatchIdx = i;
    }
  }
  
  // Return recommendation if similarity is high enough
  if (bestSimilarity > SIMILARITY_THRESHOLD && bestMatchIdx >= 0) {
    const match = model.training_data[bestMatchIdx];
    return {
      issue: issueId,
      severity: severity,
      title: match.recommendations[0].title,
      recommendation: match.recommendations[0].recommendation
    };
  }
  
  return null; // No good match found
}

async function getLocalRecommendations(report) {
  const issues = report.checks.filter(c => c.severity === 'fail' || c.severity === 'warn');
  
  if (issues.length === 0) {
    return null;
  }
  
  const recommendations = [];
  
  for (const issue of issues) {
    // Extract context from issue message if possible
    const context = {};
    
    // Try to parse numbers from message for context
    const lengthMatch = issue.message.match(/(\d+)\s*\(/);
    if (lengthMatch) {
      context.current_length = parseInt(lengthMatch[1]);
    }
    
    const countMatch = issue.message.match(/count:\s*(\d+)/i);
    if (countMatch) {
      context.count = parseInt(countMatch[1]);
    }
    
    const rec = await getLocalAIRecommendation(
      issue.id,
      issue.message,
      issue.severity,
      context
    );
    
    if (rec) {
      recommendations.push(rec);
    }
  }
  
  return recommendations.length > 0 ? { recommendations } : null;
}

