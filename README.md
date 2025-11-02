# SEO Audit Report
A comprehensive Chrome extension for analyzing and improving SEO on any web page. Get instant SEO audits with actionable recommendations powered by AI.

## Features
Comprehensive SEO Analysis: Analyzes title tags, meta descriptions, H1 tags, images, anchor text, Open Graph tags, robots meta, canonical URLs, and more
AI-Powered Recommendations: Personalized SEO recommendations using ChatGPT (optional, requires API key)
Rule-Based Fallback: Always provides helpful recommendations even without AI
Deep Network Checks: Optional network-level analysis including HTTP status codes, robots.txt, cache headers, and link audits
Real-Time Highlighting: See problematic elements directly on the page
Letter Grade Scoring: Get an instant SEO grade (A+ to F) with weighted scoring
## Installation
- From Chrome Web Store (Coming Soon)
- Visit the Chrome Web Store listing
- Click "Add to Chrome"
- Pin the extension to your toolbar for easy access
## Manual Installation (Developer Mode)
- Clone or download this repository
- Open Chrome and navigate to chrome://extensions/
- Enable "Developer mode" (toggle in top right)
- Click "Load unpacked"
- Select the seo-extension folder
- The extension icon should appear in your toolbar
## Usage
- Navigate to any website you want to audit
- Click the SEO Audit Report extension icon
- Click "Re-scan" to analyze the current page
- Review the SEO score and issues in the "Audit" tab
- Check the "Recommendations" tab for actionable fixes
- Optionally enable "Deep checks" for network-level analysis
## AI Recommendations (Optional)
- Go to the "Settings" tab
- Enter your OpenAI API key (get one at platform.openai.com)
- Your API key is stored locally and never sent to our servers
- Click "Generate Recommendations" in the Recommendations tab
- Get personalized, AI-powered SEO suggestions tailored to your website
## SEO Checks Performed
- Title Tag: Length, presence, optimization
- Meta Description: Length, presence, quality
- H1 Tags: Count, hierarchy, presence
- Image Alt Text: Missing alt attributes
- Anchor Text: Best practices analysis (exact-match ratio, descriptiveness, variety)
- Open Graph Tags: Presence of core OG tags (og:title, og:description, og:image, og:url)
- Robots Meta: noindex and nofollow directives
- Canonical URL: Presence and validity
- Viewport Meta: Mobile optimization
- Language Tag: HTML lang attribute
- Heading Hierarchy: Proper H1-H6 structure
- Deep Checks (optional): HTTP status, robots.txt, cache headers, link audits
## Privacy
- All analysis is performed locally in your browser
- OpenAI API key (if provided) is stored locally and only used for generating recommendations
- No data is sent to external servers except OpenAI (when using AI features)
- The extension only accesses web pages you actively audit
# Development
## Project Structure
- content.js - Content script that performs SEO analysis
- popup.js - Popup UI and recommendation logic
- popup.html - Extension popup HTML
- popup.css - Extension styling
- manifest.json - Chrome extension manifest
- models/ - AI models for anchor text analysis
## Requirements
- Chrome/Chromium-based browser
- Manifest V3 support
## License
The MIT License (MIT)

Copyright (c) 2025 Alex Kim

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


Support
For issues, feature requests, or questions, please open an issue on GitHub.
