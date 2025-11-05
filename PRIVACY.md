# Privacy Policy

**Last Updated:** January 2025

## Overview

SEO Audit Report ("the Extension") is committed to protecting your privacy. This privacy policy explains how the Extension handles your data.

## Data Collection and Storage

### Local Storage Only
- All analysis data is processed **locally** in your browser
- The Extension stores settings (theme preference, API key) locally using Chrome's `chrome.storage.local` API
- No data is sent to our servers or any third-party servers except as described below

### OpenAI API Key (Optional)
- If you choose to use AI-powered recommendations, you must provide your own OpenAI API key
- Your API key is stored **locally** in your browser and never sent to our servers
- When generating AI recommendations, your API key and SEO report data are sent directly to OpenAI's API (`https://api.openai.com`)
- We do not have access to your API key or the data sent to OpenAI
- The Extension uses OpenAI's GPT-3.5-turbo model for generating recommendations
- Please review [OpenAI's Privacy Policy](https://openai.com/policies/privacy-policy) for information on how they handle your data

## Permissions

The Extension requests the following permissions:

- **`activeTab`**: Allows the Extension to analyze the currently active tab's content
- **`scripting`**: Allows the Extension to inject content scripts for SEO analysis
- **`storage`**: Allows the Extension to store your preferences (theme, API key) locally
- **`https://api.openai.com/*`**: Allows the Extension to communicate with OpenAI's API (only if you provide an API key)

## Data Processing

- SEO analysis is performed **entirely in your browser** on the page you're viewing
- No page content is transmitted to external servers (except OpenAI if you use AI features)
- The Extension only accesses web pages when you actively click the "Re-scan" button

## Third-Party Services

### OpenAI
If you choose to use AI recommendations:
- Your SEO report data and API key are sent to OpenAI's API
- OpenAI's use of data is governed by their [Privacy Policy](https://openai.com/policies/privacy-policy)
- You can disable AI features by not providing an API key

## Changes to This Policy

We may update this privacy policy from time to time. We will notify you of any changes by updating the "Last Updated" date at the top of this policy.

## Contact

For questions about this privacy policy, please open an issue on the Extension's GitHub repository.

## Chrome Web Store

When submitting this Extension to the Chrome Web Store, the privacy policy URL should be:
- If hosted on GitHub: `https://github.com/yourusername/seo-extension/blob/main/PRIVACY.md`
- If hosted elsewhere: Your privacy policy URL

Note: Replace `yourusername/seo-extension` with your actual repository path.

