# SEO Audit Report

A comprehensive Chrome extension for analyzing and improving SEO on any web page. Get instant SEO audits with actionable recommendations powered by AI.

## Features

- **Comprehensive SEO Analysis**: Analyzes title tags, meta descriptions, H1 tags, images, anchor text, Open Graph tags, robots meta, canonical URLs, and more
- **AI-Powered Recommendations**: Personalized SEO recommendations using ChatGPT (optional, requires API key)
- **Rule-Based Fallback**: Always provides helpful recommendations even without AI
- **Deep Network Checks**: Optional network-level analysis including HTTP status codes, robots.txt, cache headers, and link audits
- **Real-Time Highlighting**: See problematic elements directly on the page
- **Letter Grade Scoring**: Get an instant SEO grade (A+ to F) with weighted scoring
- **Security-First**: Built with security best practices including input validation and XSS prevention

## Installation

### From Chrome Web Store (Coming Soon)
1. Visit the Chrome Web Store listing
2. Click "Add to Chrome"
3. Pin the extension to your toolbar for easy access

### Manual Installation (Developer Mode)
1. Clone or download this repository:
   ```bash
   git clone https://github.com/alexkm13/seo-extension.git
   cd seo-extension
   ```
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the `seo-extension` folder (or the folder where you cloned the repository)
6. The extension icon should appear in your toolbar

## Usage

1. Navigate to any website you want to audit
2. Click the SEO Audit Report extension icon
3. Click "Re-scan" to analyze the current page
4. Review the SEO score and issues in the "Audit" tab
5. Check the "Recommendations" tab for actionable fixes
6. Optionally enable "Deep checks" for network-level analysis

### AI Recommendations (Beta)

1. Go to the "Settings" tab
2. Enter your OpenAI API key (get one at [platform.openai.com](https://platform.openai.com/api-keys))
3. Your API key is stored locally and never sent to our servers
4. Click "Generate Recommendations" in the Recommendations tab
5. Get personalized, AI-powered SEO suggestions tailored to your website

## SEO Checks Performed

- **Title Tag**: Length, presence, optimization
- **Meta Description**: Length, presence, quality
- **H1 Tags**: Count, hierarchy, presence
- **Image Alt Text**: Missing alt attributes
- **Anchor Text**: Best practices analysis (exact-match ratio, descriptiveness, variety)
- **Open Graph Tags**: Presence of core OG tags (og:title, og:description, og:image, og:url)
- **Robots Meta**: noindex and nofollow directives
- **Canonical URL**: Presence and validity
- **Viewport Meta**: Mobile optimization
- **Language Tag**: HTML lang attribute
- **Heading Hierarchy**: Proper H1-H6 structure
- **Deep Checks** (optional): HTTP status, robots.txt, cache headers, link audits

## Privacy

- All analysis is performed locally in your browser
- OpenAI API key (if provided) is stored locally and only used for generating recommendations
- No data is sent to external servers except OpenAI (when using AI features)
- The extension only accesses web pages you actively audit

For detailed privacy information, see [PRIVACY.md](PRIVACY.md)

## Development

### Project Structure
- `content.js` - Content script that performs SEO analysis
- `popup.js` - Popup UI and recommendation logic
- `popup.html` - Extension popup HTML
- `popup.css` - Extension styling
- `manifest.json` - Chrome extension manifest
- `models/` - AI models for anchor text analysis

### Requirements
- Chrome/Chromium-based browser
- Manifest V3 support

## License

The MIT License (MIT)

Copyright (c) 2025 Alex Kim

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Support

For issues, feature requests, or questions, please open an issue on [GitHub](https://github.com/alexkm13/seo-extension/issues).

## Repository

- **GitHub**: [https://github.com/alexkm13/seo-extension](https://github.com/alexkm13/seo-extension)
- **License**: MIT License - see [LICENSE](LICENSE) for details
- **Privacy Policy**: See [PRIVACY.md](PRIVACY.md) for detailed privacy information

