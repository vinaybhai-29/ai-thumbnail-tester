# 🧪 Test User Setup for Razorpay Review

This guide explains how to create a test user account for the Razorpay team to review your application.

## Quick Setup

### Option 1: Automatic Setup (Recommended)

Run the setup script to create the test user:

```bash
node setup-test-user.js
```

This will:
- ✅ Create test user in Firebase Auth
- ✅ Set up Firestore user document
- ✅ Grant Pro status (on message

### Option 2: Manual API Call

Start your server, then call:

```bash
curl -X POST http://localhost:3000/api/create-test-user
```

### Option 3: Firebase Console (Manual)

If scripts fail, create manually in Firebase Console:

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Go to **Authentication** → **Users** → **Create user**
4. Enter credentials:
   - **Email**: `0vinaychoudhry@gmail.com`
   - **Password**: `Vinay@78`
5. Create a Firestore document at `users/{uid}`:

```javascript
{
  "email": "0vinaychoudhry@gmail.com",
  "uid": "{user-uid}",
  "displayName": "Razorpay Test User",
  "status": "Pro",
  "credits": 999,
  "uploadCount": 0,
  "createdAt": "2026-03-19T00:00:00Z",
  "expiryDate": "202
  "purpose": "Razorpay Review"
}
```

### Option 4: Bypass Login (for Razorpay Review Team)

If the login methods above fail, you can use this endpoint to get a valid authentication token.

```bash
curl -X POST http://localhost:3000/api/bypass-login \
-H "Content-Type: application/json" \
-d '{
  "email": "0vinaychoudhry@gmail.com",
  "password": "Vinay@78"
}'
```

This will return a JSON response with a `token` that can be used to authenticate with the Firebase SDK.

## Test User Credentials

```
📧 Email:    0vinaychoudhry@gmail.com
🔐 Password: Vinay@78
⭐ Status:   Pro Member
⏱️  Duration: 30 Days Unlimited Access
```
## Login Methods Available

✅ **Google Sign-In** - Works with linked Gmail account

### How to Login:

1. **Google Sign-In (Primary Method)**
   - Click sign-in button
   - Continue with Google
   - Use a Google account to sign in. If a specific test account is needed, it should be created and its credentials provided.

## Features Available to Test User

✨ **Unlimited Access:**
- 🎯 Unlimited thumbnail analysis
- 🤖 AI title generator
- 📊 Combined clickability scores
- 💡 5 improvement tips per analysis
- No daily limits
- Valid for 365 days

## Troubleshooting

### Script Fails with "Missing FIREBASE_PROJECT_ID"

Ensure your `.env` file contains:
```env
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_API_KEY=your-api-key
FIREBASE_AUTH_DOMAIN=your-auth-domain
```

### User Already Exists Error

This is normal if running the script multiple times. The script will:
- Detect existing user
- Update Firestore document
- Confirm success

To delete and recreate:
1. Go to Firebase Console → Authentication
2. Find and delete `0vinaychoudhry@gmail.com`
3. Go to Firestore → users collection
4. Find and delete the user document
5. Run script again

### Login Not Working

1. Check Firebase Console for authentication method enabled
2. Verify Firestore read/write permissions
3. Check browser console for errors (F12)

## What Razorpay Team Can Do

With this test user, Razorpay team can fully evaluate your application:

- ✅ Login without payment
- ✅ Test all features without credit restrictions
- ✅ Verify payment flow (if configured)
- ✅ Test account features
- ✅ Check policy pages
- ✅ Verify contact information

## For Production

⚠️ **Before going live:**

1. Delete test user from Firebase
2. Change any hardcoded test credentials
3. Implement proper user verification
4. Set up email verification
5. Configure password reset flow

---

**Questions?** Check server logs: `console.log()` output in Firebase functions

**Last Updated:** March 19, 2026
