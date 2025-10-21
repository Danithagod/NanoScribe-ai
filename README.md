# NanoScribe AI - Intelligent Writing Assistant

NanoScribe is a powerful Chrome extension that provides context-aware writing assistance with semantic memory capabilities. It helps you write better by understanding context, providing intelligent suggestions, and learning from your browsing history.

## 🌟 Features

### 1. Context-Aware Writing Assistance
- **Smart Autocomplete**: Get intelligent suggestions based on your current context
- **Semantic Memory**: Learns from your browsing history to provide relevant suggestions
- **Grammar & Style**: Built-in proofreader for grammar, style, and clarity improvements
- **Multilingual Support**: Works with English and other supported languages

### 2. Proofing & Corrections
- **Real-time Grammar Checking**: Instant feedback on grammar issues
- **Style Suggestions**: Improve clarity and readability
- **Contextual Corrections**: Understands the context for better suggestions
- **Explanation Support**: Get detailed explanations for corrections

### 3. Privacy & Security
- **Offline-First**: Core features work without internet connection
- **Private by Design**: All processing happens locally on your device
- **No Data Collection**: Your writing and browsing data stays on your machine
- **Open Source**: Transparent codebase and processing

## 📥 Installation & Setup

### Development Setup

The extension can be developed locally using your preferred IDE. The only requirement is having Node.js & npm installed.

**Using your preferred IDE**

If you want to work locally using your own IDE, you can clone this repo and push changes. Pushed changes will also be reflected in Lovable.

The only requirement is having Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

Follow these steps:

```sh
# Step 1: Clone the repository using the project's Git URL.
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory.
cd <YOUR_PROJECT_NAME>

# Step 3: Install the necessary dependencies.
npm i

# Step 4: Start the development server with auto-reloading and an instant preview.
npm run dev
```

**Edit a file directly in GitHub**

- Navigate to the desired file(s).
- Click the "Edit" button (pencil icon) at the top right of the file view.
- Make your changes and commit the changes.

**Use GitHub Codespaces**

- Navigate to the main page of your repository.
- Click on the "Code" button (green button) near the top right.
- Select the "Codespaces" tab.
- Click on "New codespace" to launch a new Codespace environment.
- Edit files directly within the Codespace and commit and push your changes once you're done.

## 🛠️ Technical Stack & Architecture

This project is built with:

- **Frontend Framework**: React with TypeScript
- **Build Tool**: Vite
- **UI Components**: shadcn-ui
- **Styling**: Tailwind CSS
- **Extension Framework**: Chrome Extensions Manifest V3
- **State Management**: Custom hooks and context
- **AI Processing**: Local model inference
- **Storage**: Chrome Extension Storage API

### Core Components

1. **Content Script (`content-script.tsx`)**
   - Handles text field interactions
   - Manages suggestion UI
   - Communicates with service worker

2. **Service Worker (`service-worker.ts`)**
   - Manages AI models
   - Handles background processing
   - Controls model lifecycle

3. **Proofreader (`proofreader.ts`)**
   - Grammar and style checking
   - Correction suggestions
   - Explanation generation

4. **Memory Store (`memory-store.ts`)**
   - Semantic memory management
   - Context indexing
   - Relevance ranking

### UI Components

- **Sidepanel**: Advanced settings and memory management
- **Editor Components**: Smart text editing interface
- **Status Indicators**: Model and system status visualization

## 🎯 Usage Guide

### Getting Started

1. **First Time Setup**
   - After installation, NanoScribe will download required models
   - Watch the status in the extension popup
   - Wait for all models to be ready (indicated by green checkmarks)

2. **Basic Usage**
   - Click on any text field to activate NanoScribe
   - Start typing to receive suggestions
   - Press Tab to accept suggestions
   - Press Esc to dismiss suggestions

3. **Advanced Features**
   - Click the NanoScribe icon in toolbar to open control panel
   - Use the side panel for advanced features
   - Right-click on text for context menu options

### ⌨️ Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Accept Suggestion | Tab |
| Dismiss Suggestion | Esc |
| Open Side Panel | Ctrl+Shift+N |
| Toggle Proofreading | Ctrl+Shift+P |
| Search Memories | Ctrl+Shift+F |

## 🚀 Deployment

For deployment options:

1. **Chrome Web Store** (Coming Soon)
   - Package the extension: `npm run build`
   - Submit to Chrome Web Store Developer Dashboard

2. **Local Installation**
   - Build the extension: `npm run build`
   - Open Chrome Extensions page
   - Enable Developer Mode
   - Load unpacked extension from `dist` folder

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

For more deployment options and custom domain setup, visit [Lovable Documentation](https://docs.lovable.dev/features/custom-domain#custom-domain).
