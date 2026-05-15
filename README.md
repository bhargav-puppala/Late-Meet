<div align="center">
  <img src="src/icons/icon128.png" alt="Late Meet Logo" width="120" />

  # Late Meet — Privacy-First AI Meeting Copilot for Google Meet

  **Catch up instantly when you join a meeting late — without bots, servers, or creepy transcript storage.**

  [![Version](https://img.shields.io/badge/Version-1.0.0-black?style=for-the-badge&logo=googlechrome)](https://github.com/shouri123/Late-Meet)
  [![License](https://img.shields.io/badge/License-MIT-black?style=for-the-badge)](LICENSE)
  [![Platform](https://img.shields.io/badge/Platform-Google_Meet-black?style=for-the-badge&logo=googlemeet)](https://meet.google.com)
  [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-black?style=for-the-badge)](CONTRIBUTING.md)
  [![Code of Conduct](https://img.shields.io/badge/Conduct-Contributor_Covenant-black?style=for-the-badge)](CODE_OF_CONDUCT.md)
</div>

<br />

> [!IMPORTANT]
> **Repository Scope Notice:** The website linked in this project's metadata is **not** part of this repository. 
> - Please **do not** open issues regarding UI/UX design changes or bugs for the website here.
> - This repository is dedicated exclusively to the **Late Meet Chrome Extension**.
> - The website link is being disabled to prevent further confusion. All contributions and issue reports should focus on the extension's functionality and performance.

<p align="center">
  <a href="#-the-problem">Problem</a> ·
  <a href="#-our-solution">Solution</a> ·
  <a href="#-key-features">Features</a> ·
  <a href="#%EF%B8%8F-architecture--how-it-works">Architecture</a> ·
  <a href="#%EF%B8%8F-installation--setup">Installation</a> ·
  <a href="#-technology-stack">Tech Stack</a> ·
  <a href="#-roadmap">Roadmap</a> ·
  <a href="#-contributing">Contributing</a> ·
  <a href="#-security">Security</a>
</p>

---

## 🌟 The Problem
Joining a meeting late or losing focus for a moment leaves participants disconnected and scrambling for context. Existing AI note-takers add an obnoxious "Bot has joined" participant to your call, invade your team's privacy by storing transcripts on remote servers, and often generate massive, unreadable blocks of text instead of punchy, actionable insights.

## 💡 Our Solution
**Late Meet** lives entirely natively within your browser. Without adding any disruptive bots to the call, it securely captures audio directly from the Chrome tab. It leverages **ElevenLabs' Scribe API** for state-of-the-art multilingual transcription and **OpenAI GPT models** for intelligent summarization, providing a stunning, high-performance side-panel dashboard.

We designed this with a **local-first philosophy**: all meeting data is processed locally using `chrome.storage.local` during the session, and you only need your own API keys. No external databases. No user tracking.

---

## 🚀 Key Features

* **Invisible & Native:** Uses modern Chrome `tabCapture` and Offscreen APIs to intercept audio securely without adding bots to the participant list.
* **High-Fidelity Transcription:** Utilizes the **ElevenLabs Speech-to-Text API (Scribe)** for industry-leading accuracy and robust multilingual support, gracefully falling back to OpenAI Whisper if needed.
* **Late-Joiner Briefings:** Instantly catches up late participants with targeted, private overlays summarizing missed context via hardened UI automation.
* **Proactive Intelligence:** Automatically detects meetings and initializes host-first (1+N) participant tracking for accurate reporting.
* **Bring Your Own Key (BYOK):** Full control over your data. Supply your own ElevenLabs and OpenAI API keys via the extension options.
* **Premium Interface:** A visually striking deep-monochrome UI with glassmorphism effects, smooth animations, and zero clutter. 

---

## 🏗️ Architecture & How It Works

The extension is built natively on Manifest V3 using **TypeScript and Vite 5** for a modern, optimized build process.

1. **`background.ts` (The Conductor):** Acts as the central state manager. It proactively detects Meet tabs, routes audio chunks to ElevenLabs for transcription, and coordinates intelligence queries with OpenAI.
2. **`offscreen.html` & `offscreen.ts` (The Audio Engine):** Runs a hidden offscreen document for `chrome.tabCapture`. It processes audio in chunks, ensuring zero data loss and handling raw media streams.
3. **`content.ts` (The UI Injector):** Injects floating buttons and briefing overlays. It features a hardened chat automation engine (`execCommand` based) to reliably deliver welcome messages to late joiners.
4. **AI Intelligence Layer:** Uses ElevenLabs STT for capturing speech and dynamic GPT models (like `gpt-4o-mini`) for processing text into structured insights, including Decisions, Action Items, and Strategic Sentiment.
5. **Local Storage:** Securely stores session data in `chrome.storage.local`. After each meeting, you decide to Save or Discard—nothing leaves your browser without your consent.

> 📖 For a detailed technical deep-dive, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## ⚙️ Installation & Setup

**🚨 IMPORTANT DISTINCTION 🚨**  
* **For Regular Users:** You only need the compiled `dist/` folder. This is the actual, ready-to-use extension.  
* **For Developers:** The `src/` folder contains the raw TypeScript/source code. You must compile it first using the steps below.
> ⚠️ **Prerequisites:** Google Chrome version **116 or higher** is required.  
> ⚠️ **Prerequisites:** Google Chrome version **116 or higher** is required.  
> ⚠️ **Prerequisites:** Google Chrome version **116 or higher** is required.  
> This extension is tested and supported on Chrome 116+. The underlying APIs (`chrome.tabCapture`, Offscreen Documents, Manifest V3) have lower individual minimums, but this project standardizes on Chrome 116+.
1. **Clone the repository:**
   ```bash
   git clone https://github.com/shouri123/Late-Meet.git
   cd Late-Meet
   ```
2. **Compile the Extension (Developers only):**
   ```bash
   npm install
   npm run build
   ```
   *This will generate the `dist/` folder containing the final extension.*
3. **Load into Chrome:**
   - Open Google Chrome and navigate to `chrome://extensions/`.
   - Enable **Developer mode** in the top right corner.
   - Click **Load unpacked** and select the **`dist/`** directory (NOT the root or `src/` directory).
4. **Configure the Copilot:**
   - Click the extension icon in the toolbar and open the **Options** menu.
   - Enter your **ElevenLabs API Key** (for superior transcription) and your **OpenAI API Key** (for summarization intelligence).
5. **Join a Meeting:**
   - Join any active Google Meet.
   - Click the floating **Start Copilot** button.
   - Open the full Side Panel dashboard to view live intelligence!

---

## 🛠 Technology Stack

* **Extension Architecture:** Manifest V3 compliant, Offscreen Documents, Service Workers.
* **Build Tools:** TypeScript, Vite 5, `@crxjs/vite-plugin`.
* **Design System:** Custom Vanilla CSS, high-contrast monochrome aesthetic, SVG-native iconography.
* **Storage:** `chrome.storage.local` (Local-first, NO BAAS dependencies).
* **AI Pipeline:** ElevenLabs STT (Scribe v2) for transcription, and dynamic GPT models for Intelligence/Summarization.

---

## 🗺 Roadmap

### Phase 1: Core Foundation ✅
- Native Google Meet integration without bot participants.
- Real-time offline audio capture via Chrome Offscreen APIs.
- Premium monochrome UI extension & side panel.
- BYOK integration for processing.

### Phase 2: Local & Privacy Overhaul ✅
- Strip Supabase/backend dependencies.
- Local-first session management and storage.
- ElevenLabs Scribe integration for superior transcription.
- Intelligent rolling LLM context prompting.

### Phase 3: Platform Expansion 🔄 *(Planned)*
- **Offline/Native Support:** Offline transcription via local Whisper / WebGPU.
- **Smart Tracking:** Speaker diarization and action item assignee routing.
- **Multi-Platform:** Zoom and Microsoft Teams support.
- **On-the-fly Translation:** Bridging language gaps during international calls.

> 📖 See the full roadmap with contributor-friendly tasks at [`ROADMAP.md`](ROADMAP.md).

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! We have labeled issues for all skill levels.

> ⚠️ **Before making ANY changes**, you **must fork** this repository and **create a new branch** from `main`. Direct commits to the main repository are not accepted. All contributions must come through Pull Requests from your fork.

**Quick start:**
1. **Fork** the repo on GitHub (click the Fork button)
2. **Clone** your fork: `git clone https://github.com/<your-username>/Late-Meet.git`
3. **Create a new branch**: `git checkout -b feature/your-feature-name`
4. `npm install` → `npm run build`
5. Load the `dist/` folder in Chrome
6. Make your changes, test, and submit a PR

**Found a bug or have an idea?** Open a public issue on the [Issues page](https://github.com/shouri123/Late-Meet/issues)! We use issue templates for [bug reports](.github/ISSUE_TEMPLATE/bug_report.md) and [feature requests](.github/ISSUE_TEMPLATE/feature_request.md) to keep things organized.

> [!CAUTION]
> **Issue Scope:** Please only report issues and feature requests for the **Chrome Extension**. Do not request UI/UX design changes or report bugs for the website.

When contributing:
1. Emphasize vanilla, zero-dependency JavaScript workflows where possible.
2. Adhere strictly to the monochromatic UI design system.

> 📖 See [`CONTRIBUTING.md`](CONTRIBUTING.md) for full setup instructions, project structure walkthrough, and PR guidelines.

---

## 🐛 Known Issues

| Issue | Status | Link |
|-------|--------|------|
| Audio capture intermittently fails after migration from OpenAI Whisper to ElevenLabs Scribe STT | 🔴 Open | [#1](https://github.com/shouri123/Late-Meet/issues/1) |

> If you encounter any other issues **with the extension**, please [open a new issue](https://github.com/shouri123/Late-Meet/issues/new/choose) with as much detail as possible. Screenshots and console logs are very helpful!

---

## 🔒 Security

Late Meet follows a strict **BYOK (Bring Your Own Key)** model with **local-only data storage**. No meeting data ever leaves your browser without your consent.

If you discover a security vulnerability, **please do not open a public issue**. Report it privately to **chakrabortyshouri@gmail.com**.

> 📖 See [`SECURITY.md`](SECURITY.md) for our full security policy and data handling practices.

---

## 💬 Support

Need help? Check out our [Support guide](SUPPORT.md) or open a [Discussion](https://github.com/shouri123/Late-Meet/discussions).

---

## 📜 License

Distributed under the MIT License. See [`LICENSE`](LICENSE) for more information.

<div align="center">
  <br />
  <i>Built for high-performance teams who value focus and privacy.</i>
</div>
