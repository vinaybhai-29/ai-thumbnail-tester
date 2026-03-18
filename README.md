# 🎯 AI Thumbnail Tester - Secure Backend Version

एक AI-powered YouTube Thumbnail CTR Analyzer जो OpenRouter के Gemini 2.0 का उपयोग करता है। **API Key अब पूरी तरह सुरक्षित है!**

## 📋 निर्देश (Setup)

### 1️⃣ Node.js Dependencies Install करें
```bash
npm install
```

यह आपके `package.json` से सभी आवश्यक पैकेजेस इंस्टॉल करेगा:
- **express** - Web server
- **dotenv** - .env फाइल से environment variables लोड करने के लिए
- **cors** - Frontend से requests को allow करने के लिए

### 2️⃣ .env फाइल को सेटअप करें
`.env` फाइल में आपकी OpenRouter API Key पहले से है:
```
OPENROUTER_API_KEY=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
PORT=3000
NODE_ENV=development
```

⚠️ **महत्वपूर्ण**: `.env` फाइल को Git में कभी commit न करें! (.gitignore में पहले से है)

### 3️⃣ Server चलाएं
```bash
npm start
```

✅ **Server शुरू हो जाएगा**: `http://localhost:3000`

**Development के लिए (auto-restart के साथ):**
```bash
npm run dev
```

### 4️⃣ ब्राउज़र में खोलें
```
http://localhost:3000
```

## 🔒 सुरक्षा (Security) - क्या बदला?

### ❌ पहले (असुरक्षित):
- API Key सीधे `index.html` में थी
- कोई भी आपकी API Key को browser के DevTools से देख सकता था

### ✅ अब (सुरक्षित):
- API Key `.env` फाइल में है (सर्वर पर)
- Frontend को API को सीधे नहीं पता है
- सभी API calls बैकएंड के through होते हैं
- `.env` फाइल कभी frontend को नहीं जाती

## 📁 फाइल Structure
```
MyVideoApp/
├── server.js           # Express बैकएंड सर्वर
├── index.html          # Frontend (updated)
├── package.json        # Node.js dependencies
├── .env                # API Key (सुरक्षित ✅)
├── .env.example        # Template for .env
└── .gitignore          # .env को exclude करता है
```

## 🚀 API Endpoint

**POST** `/api/analyze-thumbnail`

**Request Body:**
```json
{
  "base64": "iVBORw0KGgoAAAANS...",
  "mimeType": "image/png"
}
```

**Response:**
```json
{
  "score": 85,
  "tips": [
    "High contrast colors attract more views",
    "Include face expressions for better CTR",
    "Use bold fonts for text overlay"
  ]
}
```

## 🛠️ Troubleshooting

### Error: "Cannot find module 'express'"
```bash
npm install
```

### Error: "Port 3000 already in use"
अपने `.env` में PORT बदलें:
```
PORT=3001
```

### API Key invalid?
अपनी OpenRouter API Key को `.env` में सही से paste करें

## 📝 Production के लिए Tips
- `NODE_ENV=production` से variables में change करें
- CORS को specific domains के लिए configure करें
- Environment variables को safely store करें
- SSL/HTTPS का उपयोग करें

---
**Created by:** Vinay Chaudhary  
**Updated:** March 2026  
**License:** MIT
