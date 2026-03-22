# 🎯 AI Thumbnail Tester with Firebase Integration

A modern, AI-powered YouTube thumbnail analyzer with phone authentication and lead generation flow. Built with Firebase, Express.js, and Google's Gemini Vision API.

## ✨ Features

- **Instant AI Analysis**: Get CTR scores (0-100%) and actionable tips using Gemini 2.0 Flash
- **Phone Authentication**: Secure Firebase Phone Auth with OTP verification
- **Free Daily Credits**: 2 free thumbnail analyses per day tracked via local storage
- **Curiosity Gap**: Dynamic 3-4 second loading animation before showing results
- **Lead Generation**: Phone verification modal to capture user contact info
- **Firestore Integration**: Save user data and track usage across devices
- **Responsive Design**: Works seamlessly on desktop and mobile
- **Country Support**: Multiple country codes for international users

## 🚀 Quick Start

### Prerequisites
- Node.js 14+ and npm
- Firebase project with Phone Auth enabled
- OpenRouter API key for Gemini 2.0 model access

### Installation

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment**
   The `.env` file already contains your Firebase credentials:
   ```
   FIREBASE_API_KEY=your_firebase_api_key_here
   FIREBASE_AUTH_DOMAIN=ai-thumbnail-tester-34d50.firebaseapp.com
   FIREBASE_PROJECT_ID=ai-thumbnail-tester-34d50
   FIREBASE_STORAGE_BUCKET=ai-thumbnail-tester-34d50.firebasestorage.app
   FIREBASE_MESSAGING_SENDER_ID=583406006410
   FIREBASE_APP_ID=1:583406006410:web:813c7098d38536b2817d73
   FIREBASE_MEASUREMENT_ID=G-4M05P71X3M
   OPENROUTER_API_KEY=your_openrouter_api_key_here
   PORT=3000
   ```

3. **Firebase Setup**
   Go to your Firebase Console (ai-thumbnail-tester-34d50):
   - **Enable Phone Authentication**: Authentication > Sign-in method > Phone > Enable
   - **Enable Firestore Database**: Firestore Database > Create Database > Start in production mode
   - **Set reCAPTCHA**: Authentication > Settings > reCAPTCHA configuration

4. **Run the Server**
   ```bash
   npm start
   ```
   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

5. **Open in Browser**
   ```
   http://localhost:3000
   ```

## 📱 How It Works

### User Flow

1. **Upload Thumbnail**: User clicks to upload a YouTube thumbnail image
2. **Start Analysis**: Clicks "Analyze Now" button
3. **Dynamic Loading** (3-4 seconds):
   - Shows engaging loading animation
   - Progress bar fills with gradient
   - Display dynamic messages:
     - "Analyzing colors..."
     - "Checking CTR potential..."
     - "Evaluating composition..."
     - "Generating report..."
4. **Authentication Gate** (if not logged in):
   - Modal popup appears: "Your Thumbnail Report is Ready! 🎉"
   - Shows phone verification form with country code selector
   - reCAPTCHA verification required
   - User enters 10-digit phone number
5. **OTP Verification**:
   - Firebase sends OTP via SMS
   - User enters 6-digit OTP
   - On successful verification:
     - User data saved to Firestore
     - Firebase session created
     - User granted access to daily credits
6. **Show Results**:
   - CTR Score displayed with color coding
     - 🔴 Red (0-40%): Low engagement potential
     - 🟡 Yellow (40-70%): Good engagement potential
     - 🟢 Green (70-100%): Excellent engagement potential
   - 3 actionable tips to improve CTR
   - Copy button to share results

### Free Credits System

**Non-Logged-In Users**:
- Tracked via `localStorage['thumbnailTestUsage']`
- Limited to 2 tests per calendar day
- Resets at midnight local time
- Must verify phone to continue testing

**Logged-In Users**:
- Daily limits stored in Firestore `users` collection
- Synced across devices
- Resets daily at midnight UTC
- Verification enables credit system

## 🔐 Firebase Backend Endpoints

### 1. POST `/api/analyze-thumbnail`
Analyzes thumbnail image and returns CTR score + tips

**Request**:
```json
{
  "base64": "iVBORw0KGgoAAAANSU...",
  "mimeType": "image/png"
}
```

**Response**:
```json
{
  "score": 78,
  "tips": [
    "Add contrasting text to increase legibility",
    "Use warmer colors to evoke excitement",
    "Increase face visibility in the thumbnail"
  ]
}
```

### 2. POST `/api/verify-phone-auth`
Saves verified user to Firestore

**Request**:
```json
{
  "uid": "firebase-uid",
  "phoneNumber": "+911234567890"
}
```

**Response**:
```json
{
  "success": true,
  "message": "User verified and saved"
}
```

### 3. POST `/api/get-user-stats`
Retrieves user's daily test limits

**Request**:
```json
{
  "uid": "firebase-uid"
}
```

**Response**:
```json
{
  "testsRemaining": 2,
  "testsUsedToday": 0,
  "totalUsed": 45
}
```

### 4. POST `/api/update-test-usage`
Increments user's test counter

**Request**:
```json
{
  "uid": "firebase-uid"
}
```

**Response**:
```json
{
  "success": true
}
```

## 🗄️ Firestore Database Schema

### Collection: `users`

```
/users/{uid}
├── phoneNumber: string (e.g., "+911234567890")
├── createdAt: timestamp
├── testsUsedToday: number (0-2)
├── totalTestsUsed: number
├── lastTestDate: string (YYYY-MM-DD)
└── verified: boolean
```

**Example Document**:
```json
{
  "phoneNumber": "+918765432100",
  "createdAt": "2024-03-17T10:30:00Z",
  "testsUsedToday": 1,
  "totalTestsUsed": 5,
  "lastTestDate": "2024-03-17",
  "verified": true
}
```

## 🎨 Frontend Architecture

### Key Components

1. **Thumbnail Analyzer**
   - File upload with preview
   - Base64 encoding for API transmission
   - Error handling and validation

2. **Dynamic Loader**
   - Animated progress bar with gradient
   - Rotating loading messages
   - 3.5-second total animation

3. **Auth Modal**
   - Phone number input with 7 countries
   - reCAPTCHA integration
   - OTP input field
   - Status feedback

4. **Results Display**
   - Color-coded CTR score
   - Formatted tip list
   - Copy-to-clipboard functionality

### State Management

- **Firebase Auth**: `auth.onAuthStateChanged()`
- **Current User**: Global `currentUser` variable
- **Pending Results**: Stored in `pendingResult` until auth completes
- **Local Storage**: `thumbnailTestUsage` for free tier tracking

## 🔄 Authentication Flow

```
User Uploads Image
        ↓
Click Analyze
        ↓
Check Free Credits (localStorage)
        ↓
Send to Backend (API)
        ↓
Show 3-4s Dynamic Loading
        ↓
            ├─ If Logged In → Show Result
            │
            └─ If Not Logged In → Show Auth Modal
                    ↓
                Enter Phone + reCAPTCHA
                    ↓
                Firebase Sends OTP
                    ↓
                Enter 6-digit OTP
                    ↓
                Verify with Firebase
                    ↓
                Save to Firestore
                    ↓
                Create User Session
                    ↓
                Show Result + Store Usage
```

## 📊 Loading Animation States

The loader transitions through 4 engaging messages:

1. **0-25%**: "Analyzing colors..." 🎨
2. **25-50%**: "Checking CTR potential..." 📊
3. **50-75%**: "Evaluating composition..." 🎯
4. **75-100%**: "Generating report..." 📄

Progress bar emits a glowing cyan light with `box-shadow`.

## 🛣️ Next Steps: Razorpay Integration

Once users exhaust their free 2 daily tests, they can upgrade via Razorpay:

```javascript
// Ready for future implementation
// RAZORPAY_KEY_ID stored in .env
// RAZORPAY_KEY_SECRET stored in .env

// Flow:
// 1. User hits daily limit
// 2. Show upgrade modal with pricing
// 3. Create order via /api/create-razorpay-order
// 4. Open payment checkout
// 5. Save transaction to Firestore
// 6. Increase daily limits post-payment
```

## 🔐 Security Features

- ✅ Firebase Authentication (industry standard)
- ✅ reCAPTCHA v3 to prevent bot abuse
- ✅ Firestore security rules (enable in console)
- ✅ Phone verification for lead quality
- ✅ Daily limits prevent API abuse
- ✅ Environment variables for sensitive data

## 📝 Firestore Security Rules (Recommended)

Add to your Firestore Database > Rules:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Users can only read/write their own data
    match /users/{uid} {
      allow read, write: if request.auth.uid == uid;
    }
  }
}
```

## 🐛 Troubleshooting

### "Firebase not initialized"
- Ensure `.env` contains all Firebase credentials
- Reload page if error persists

### "reCAPTCHA error"
- Check Firebase Console > Authentication > Settings
- Ensure your domain is whitelisted in reCAPTCHA

### "Phone Auth not working"
- Enable Phone Authentication in Firebase Console
- Check that your app is in the reCAPTCHA trusted list
- Ensure phone number includes country code

### "OTP not received"
- Check phone number format (10 digits + country code)
- Verify +91 SMS gateway is active (for India)
- Test with different country if available

## 📈 API Usage Example

```bash
# Test backend health
curl http://localhost:3000/health

# Example thumbnail analysis (Python)
python3 << EOF
import requests
import base64

with open('thumbnail.png', 'rb') as f:
    base64_img = base64.b64encode(f.read()).decode()

response = requests.post(
    'http://localhost:3000/api/analyze-thumbnail',
    json={
        'base64': base64_img,
        'mimeType': 'image/png'
    }
)

print(response.json())
EOF
```

## 📦 Dependencies

### Backend
- `express` ^4.18.2 - Web server
- `firebase-admin` ^12.0.0 - Firebase backend SDK
- `cors` ^2.8.5 - Cross-origin requests
- `dotenv` ^16.0.3 - Environment variables

### Frontend
- Firebase JavaScript SDK 10.7.0
  - `firebase-app`
  - `firebase-auth`
  - `firebase-firestore`
- Google reCAPTCHA API
- OpenRouter API (via backend)

## 🤝 Support

For issues or questions:
- Check Firebase Console for auth/database status
- Review browser console for client-side errors
- Check terminal for server-side logs
- Verify API keys in `.env` file

## 📄 License

MIT - Feel free to use for your projects!

---

**Created by**: Vinay Chaudhary  
**Project**: AI Thumbnail Tester with Lead Generation  
**Firebase Project**: ai-thumbnail-tester-34d50
