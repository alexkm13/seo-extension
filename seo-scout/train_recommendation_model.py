#!/usr/bin/env python3
"""
Training script for SEO recommendation model using TF-IDF embeddings.
Creates a lightweight, browser-compatible model for matching SEO issues to recommendations.
"""

import json
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

def create_training_data_from_rules():
    """
    Generate initial training data from your existing rule-based recommendations.
    You can expand this with real examples later.
    """
    training_data = [
        {
            "issue_id": "title-length",
            "issue_message": "Title length: 35 (recommended 50–60)",
            "severity": "warn",
            "context": {"current_length": 35, "recommended_min": 50, "recommended_max": 60},
            "recommendations": [{
                "title": "Title Too Short",
                "recommendation": "Your title is 35 characters, but should be 50-60 characters for optimal SEO. Add more descriptive keywords while keeping it concise and compelling. Include your primary keyword near the beginning. Example: Expand 'Welcome' to 'Welcome to Our Premium Services - Quality & Trust' (56 chars)."
            }]
        },
        {
            "issue_id": "title-length",
            "issue_message": "Title length: 75 (recommended 50–60)",
            "severity": "warn",
            "context": {"current_length": 75, "recommended_min": 50, "recommended_max": 60},
            "recommendations": [{
                "title": "Title Too Long",
                "recommendation": "Your title is 75 characters and will be truncated in search results. Shorten it to 50-60 characters by removing unnecessary words while keeping the most important keywords. Focus on the core message first."
            }]
        },
        {
            "issue_id": "h1-count",
            "issue_message": "H1 count: 0",
            "severity": "fail",
            "context": {"h1_count": 0},
            "recommendations": [{
                "title": "Missing H1 Tag",
                "recommendation": "Add a single H1 tag containing your primary keyword. The H1 should describe the main topic of the page and help search engines understand your content structure. Place it near the top of your content: <h1>Your Primary Keyword Here</h1>."
            }]
        },
        {
            "issue_id": "h1-count",
            "issue_message": "H1 count: 3",
            "severity": "warn",
            "context": {"h1_count": 3},
            "recommendations": [{
                "title": "Multiple H1 Tags",
                "recommendation": "You have 3 H1 tags, but should have exactly one per page. Convert extra H1s to H2 or H3 tags to maintain proper heading hierarchy. The single H1 should represent the main topic of the page."
            }]
        },
        {
            "issue_id": "meta-description",
            "issue_message": "Meta description length: 0 (recommended 120–160)",
            "severity": "fail",
            "context": {"current_length": 0, "recommended_min": 120, "recommended_max": 160},
            "recommendations": [{
                "title": "Missing Meta Description",
                "recommendation": "Add a meta description tag in your HTML head section. It should be 120-160 characters, include your primary keyword, and provide a compelling summary that encourages clicks. Example: <meta name=\"description\" content=\"Your compelling 120-160 character description here\">"
            }]
        },
        {
            "issue_id": "meta-description",
            "issue_message": "Meta description length: 95 (recommended 120–160)",
            "severity": "warn",
            "context": {"current_length": 95, "recommended_min": 120, "recommended_max": 160},
            "recommendations": [{
                "title": "Meta Description Too Short",
                "recommendation": "Your meta description is 95 characters. Expand it to 120-160 characters to provide more context and include a call-to-action. This improves click-through rates from search results."
            }]
        },
        {
            "issue_id": "canonical",
            "issue_message": "No canonical tag found.",
            "severity": "warn",
            "context": {},
            "recommendations": [{
                "title": "Missing Canonical Tag",
                "recommendation": "Add a canonical tag to prevent duplicate content issues. Include <link rel=\"canonical\" href=\"https://yoursite.com/page-url\"> in your HTML head. This tells search engines which version of the page is the primary one."
            }]
        },
        {
            "issue_id": "robots-meta",
            "issue_message": "Meta robots contains noindex (page won't be indexed).",
            "severity": "fail",
            "context": {},
            "recommendations": [{
                "title": "Page Blocked by Noindex",
                "recommendation": "Your page has a noindex meta tag, which prevents search engines from indexing it. Remove <meta name=\"robots\" content=\"noindex\"> if you want this page to appear in search results. Only use noindex for pages you intentionally want to exclude from search."
            }]
        },
        {
            "issue_id": "image-alt",
            "issue_message": "Images missing alt: 5/10",
            "severity": "warn",
            "context": {"missing": 5, "total": 10},
            "recommendations": [{
                "title": "Images Missing Alt Text",
                "recommendation": "5 out of 10 images are missing alt text. Add descriptive alt attributes to all images: <img src=\"image.jpg\" alt=\"Descriptive text\">. Alt text improves accessibility and helps images rank in image search."
            }]
        },
        {
            "issue_id": "open-graph",
            "issue_message": "Open Graph: Missing og:description, og:url. Present: title, image. Total: 2",
            "severity": "warn",
            "context": {},
            "recommendations": [{
                "title": "Missing Open Graph Tags",
                "recommendation": "Add all four core Open Graph tags for social sharing: <meta property=\"og:title\" content=\"Title\">, <meta property=\"og:description\" content=\"Description\">, <meta property=\"og:image\" content=\"Image URL\">, and <meta property=\"og:url\" content=\"URL\">. These tags control how your page appears when shared on social media."
            }]
        },
        {
            "issue_id": "anchor-text",
            "issue_message": "Empty anchors: 5; weak anchors (AI): 3; junk anchors (AI): 2. Total problematic: 10.",
            "severity": "warn",
            "context": {},
            "recommendations": [{
                "title": "Weak Anchor Text",
                "recommendation": "Some links have weak anchor text (empty, too short, or generic). Improve anchor text by using descriptive, keyword-rich phrases that indicate the link destination. Good anchor text helps both users and search engines understand the link context."
            }]
        },
    ]
    return training_data

def train_model(training_data):
    """
    Train a TF-IDF based recommendation model.
    """
    # Create feature vectors for each issue
    issue_texts = []
    for item in training_data:
        # Combine issue_id, message, and context into one text for embedding
        context_str = json.dumps(item.get('context', {}), sort_keys=True)
        text = f"{item['issue_id']} {item['issue_message']} {context_str}"
        issue_texts.append(text)
    
    # Create TF-IDF vectorizer
    # Using smaller max_features for browser compatibility
    vectorizer = TfidfVectorizer(
        max_features=500,  # Reduced for smaller model size
        ngram_range=(1, 2),  # Unigrams and bigrams
        min_df=1,  # Include all terms
        lowercase=True,
        stop_words='english'
    )
    
    print(f"Training on {len(training_data)} examples...")
    embeddings = vectorizer.fit_transform(issue_texts)
    
    # Convert to dense array for JSON serialization
    embeddings_dense = embeddings.toarray().tolist()
    
    # Create model output (convert numpy types to native Python types for JSON)
    model_output = {
        'vocabulary': {str(k): int(v) for k, v in vectorizer.vocabulary_.items()},
        'idf': [float(x) for x in vectorizer.idf_.tolist()],
        'feature_names': vectorizer.get_feature_names_out().tolist(),
        'embeddings': embeddings_dense,
        'training_data': training_data,
        'n_features': int(len(vectorizer.get_feature_names_out()))
    }
    
    return model_output

def test_model(model_output, test_issue_id, test_message, test_context={}):
    """
    Test the model with a new issue.
    """
    from sklearn.feature_extraction.text import TfidfVectorizer
    import numpy as np
    
    # Reconstruct vectorizer (for testing only)
    vectorizer = TfidfVectorizer(
        vocabulary=model_output['vocabulary'],
        ngram_range=(1, 2),
        lowercase=True
    )
    vectorizer.idf_ = np.array(model_output['idf'])
    
    # Create test vector
    test_text = f"{test_issue_id} {test_message} {json.dumps(test_context, sort_keys=True)}"
    test_vector = vectorizer.transform([test_text]).toarray()[0]
    
    # Find most similar
    similarities = []
    for i, embedding in enumerate(model_output['embeddings']):
        embedding_arr = np.array(embedding)
        similarity = np.dot(test_vector, embedding_arr) / (np.linalg.norm(test_vector) * np.linalg.norm(embedding_arr) + 1e-8)
        similarities.append((i, similarity))
    
    # Sort by similarity
    similarities.sort(key=lambda x: x[1], reverse=True)
    
    best_match_idx, best_similarity = similarities[0]
    best_match = model_output['training_data'][best_match_idx]
    
    print(f"\nTest Issue: {test_issue_id} - {test_message}")
    print(f"Best Match (similarity: {best_similarity:.3f}):")
    print(f"  Issue: {best_match['issue_id']} - {best_match['issue_message']}")
    print(f"  Recommendation: {best_match['recommendations'][0]['title']}")
    print(f"  {best_match['recommendations'][0]['recommendation'][:100]}...")

def main():
    print("SEO Recommendation Model Trainer")
    print("=" * 50)
    
    # Create training data
    training_data = create_training_data_from_rules()
    print(f"Created {len(training_data)} training examples")
    
    # Train model
    model_output = train_model(training_data)
    
    # Save model
    output_file = 'models/recommendation_model.json'
    with open(output_file, 'w') as f:
        json.dump(model_output, f, indent=2)
    
    print(f"\nModel saved to {output_file}")
    print(f"Model size: {len(json.dumps(model_output)) / 1024:.1f} KB")
    
    # Test the model
    print("\n" + "=" * 50)
    print("Testing model...")
    test_model(model_output, "title-length", "Title length: 42 (recommended 50–60)", {"current_length": 42})
    test_model(model_output, "h1-count", "H1 count: 2", {"h1_count": 2})
    
    print("\n" + "=" * 50)
    print("Training complete!")
    print("\nNext steps:")
    print("1. Review and expand training_data.json with more examples")
    print("2. Run this script again to retrain")
    print("3. Integrate the model into popup.js using the provided JavaScript code")

if __name__ == '__main__':
    main()

